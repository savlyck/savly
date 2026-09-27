"""SAVLY local price gateway. Secrets never served to the browser."""
import os, json, time, math, re, getpass, threading, unicodedata, urllib.request, urllib.error
from urllib.parse import urlsplit, parse_qs, urlencode
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import households

ROOT = Path(__file__).resolve().parent / 'public'
STORES = {'REMA_1000':'rem','KIWI':'kiwi','COOP_OBS':'obs','COOP_EXTRA':'extra','MENY_NO':'meny','SPAR_NO':'spar','BUNNPRIS':'bunnpris','JOKER_NO':'joker','COOP_MEGA':'mega','COOP_PRIX':'prix','COOP_MARKED':'marked','MATKROKEN':'matkroken','NAERBUTIKKEN':'narbutikken','HOLDBART':'holdbart'}
# EUROSPAR and Gigaboks stay in the UI; do not invent undocumented API mappings.
KEY = os.environ.get('KASSALAPP_API_KEY', '').strip()
CACHE, REQUESTS = {}, []
LOCK = threading.Lock()
SLOTS = threading.BoundedSemaphore(4)

class ApiError(Exception):
    def __init__(self, status, message): self.status, self.message = status, message

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ApiError(502, 'Datakilden svarte med en uventet omdirigering.')

def fetch(path):
    if not KEY: raise ApiError(503, 'API-nøkkel mangler på serveren.')
    now = time.monotonic()
    with LOCK:
        hit = CACHE.get(path)
        if hit and now-hit[0] < 300: return hit[1]
        REQUESTS[:] = [t for t in REQUESTS if now-t < 3600]
        if len(REQUESTS) >= 100 or sum(now-t < 60 for t in REQUESTS) >= 20:
            raise ApiError(429, 'Mange prissøk. Vent litt og prøv igjen.')
        REQUESTS.append(now)
    if not SLOTS.acquire(blocking=False): raise ApiError(429, 'Prissøk pågår. Prøv igjen om litt.')
    try:
        req = urllib.request.Request('https://kassal.app/api/v1'+path, headers={'Authorization':'Bearer '+KEY,'Accept':'application/json'})
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=15) as response:
            raw = response.read(5_000_001)
            if len(raw)>5_000_000: raise ApiError(502, 'Svaret fra datakilden er for stort.')
            result = json.loads(raw)
        with LOCK:
            if len(CACHE)>=150: CACHE.pop(next(iter(CACHE)))
            CACHE[path]=(now,result)
        return result
    except urllib.error.HTTPError as e:
        status = 429 if e.code==429 else 502
        messages = {
            400: 'Kassalapp avviste søkeparameterne (400). Oppdater SAVLY-serveren.',
            401: 'Kassalapp avviste API-nøkkelen (401). Start serveren på nytt med riktig nøkkel.',
            403: 'Kassalapp tillater ikke denne forespørselen (403). Sjekk API-tilgangen.',
            404: 'Ingen data funnet hos Kassalapp (404). Prøv et annet produkt.',
            422: 'Kassalapp avviste søkeparameterne (422). Oppdater SAVLY-serveren.',
            429: 'Kassalapps forespørselsgrense er nådd (429). Vent litt før du søker igjen.'
        }
        # Only expose the status, never upstream response bodies or credentials.
        raise ApiError(status, messages.get(e.code, f'Kassalapp svarte med feil {e.code}. Prøv igjen senere.'))
    except (urllib.error.URLError, TimeoutError, ValueError):
        raise ApiError(502, 'Kunne ikke hente priser. Prøv igjen senere.')
    finally: SLOTS.release()

def number(value):
    return value if isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value) and value>=0 else None

def safe_url(value):
    return value if isinstance(value,str) and value.startswith('https://') else ''

def normalize(product, ean=None):
    store = product.get('store') or {}
    if isinstance(store,list): store = store[0] if len(store)==1 else {}
    if not isinstance(store,dict) or store.get('code') not in STORES: return None
    current = product.get('current_price')
    if isinstance(current,list): current=current[0] if len(current)==1 else None
    date = None
    if isinstance(current,dict):
        date=current.get('date'); price=number(current.get('price')); unit=number(current.get('unit_price'))
    else:
        price=number(current); unit=number(product.get('current_unit_price'))
        history=product.get('price_history') or []
        dates=[x.get('date') for x in history if isinstance(x,dict) and x.get('price')==price and isinstance(x.get('date'),str)]
        date=max(dates) if dates else None
    return {'id':product.get('id'),'ean':ean or product.get('ean'),'name':str(product.get('name') or 'Ukjent produkt'),
        'store':STORES[store['code']],'price':price,'unitPrice':unit,'priceDate':date,
        'updatedAt':product.get('updated_at'),'weight':number(product.get('weight')),'unit':product.get('weight_unit'),
        'image':safe_url(product.get('image')),'url':safe_url(product.get('url'))}

# Search provider matches arbitrary substrings; rank meaningful product-name matches.
def search_words(text):
    text = unicodedata.normalize('NFKC', str(text)).casefold()
    return re.findall(r'[^\W_]+', text, flags=re.UNICODE)

CHEESE_WORDS = {
    'ost', 'osten', 'oster', 'gulost', 'hvitost', 'kvitost', 'brunost',
    'geitost', 'fløtemysost', 'mysost', 'kremost', 'smøreost', 'smelteost',
    'blåmuggost', 'hvitmuggost', 'kvitmuggost', 'salatost', 'burgerost',
    'pizzaost', 'revetost', 'cheddarost', 'gaudaost', 'goudaost',
    'mozzarellaost', 'parmesanost', 'fetaost', 'chevreost', 'chèvreost',
    'jarlsbergost', 'nøkkelost', 'pultost', 'primost', 'cottageost',
    'norvegia', 'jarlsberg', 'cheddar', 'gouda', 'gauda', 'mozzarella',
    'parmesan', 'parmigiano', 'pecorino', 'brie', 'camembert', 'feta',
    'chevre', 'chèvre', 'halloumi', 'grillost', 'ricotta', 'mascarpone',
    'gorgonzola', 'roquefort', 'emmentaler', 'edamer', 'manchego', 'cheese',
    'baconost', 'skinkeost', 'rekeost', 'tubeost'
}

# Whole compound words only: common Norwegian food names are often joined.
# Never fall back to arbitrary substrings (e.g. ost in leverpostei).
FOOD_COMPOUNDS = {
    'melk': {'lettmelk','helmelk','heilmelk','skummetmelk','ekstralettmelk','kulturmelk','surmelk','sjokolademelk','havremelk','mandelmelk','soyamelk','kokosmelk','geitemelk','laktosefrimelk'},
    'brød': {'grovbrød','kneippbrød','kneipp','loff','rugbrød','havrebrød','surdeigsbrød','fullkornsbrød','landbrød','speltbrød','knekkebrød','polarbrød','pitabrød','nanbrød','naanbrød','flatbrød','hvitløksbrød'},
    'egg': {'gårdsegg','frokostegg','økologiegg','vaktelegg'},
    'ris': {'jasminris','basmatiris','fullkornsris','grøtris','sushiris','middagsris','naturris'},
    'kjøtt': {'storfekjøtt','svinekjøtt','kyllingkjøtt','lammekjøtt','reinsdyrkjøtt','reinkjøtt'},
    'smør': {'meierismør','setersmør','rørossmør','kviteseidsmør','sætersmør'},
    'ost': CHEESE_WORDS,
}

# A cheese ingredient/flavour is not a cheese product. These are name-based
# intent rules, not a claim that the provider supplies verified categories.
PREPARED_FOODS = {
    'grandiosa', 'ristorante', 'bigone', 'doritos', 'cheez', 'cheezdoodles',
    'pizza', 'minipizza', 'pizzabaguette', 'pizzasnurr', 'pizzasnurrer',
    'tortillachips', 'nachochips', 'potetchips', 'chips', 'nachos', 'snacks',
    'ostepop', 'cheeseballs', 'osteballer', 'ostechips', 'ostekjeks',
    'kjeks', 'crackers', 'knekkebrød', 'brød', 'ostebrød', 'rundstykke',
    'rundstykker', 'horn', 'baguette', 'baguetter', 'sandwich', 'wrap', 'wraps',
    'toast', 'ostesmørbrød', 'smørbrød', 'pasta', 'lasagne', 'lasagna',
    'tortellini', 'ravioli', 'macaroni', 'makaroni', 'nudler', 'suppe',
    'saus', 'ostesaus', 'pastasaus', 'dipp', 'dip', 'dressing',
    'burger', 'cheeseburger', 'hamburger', 'pølse', 'pølser', 'ostepølse',
    'ostepølser', 'wiener', 'grillpølse', 'grillpølser', 'bacon', 'skinke',
    'salami', 'salat', 'pai', 'quiche', 'grateng', 'panini', 'burrito',
    'burritos', 'enchilada', 'enchiladas', 'focaccia', 'croissant',
    'ostekake', 'cheesecake', 'kake', 'pommes', 'potetgull', 'popcorn',
    'grøt', 'pudding', 'sjokolade', 'dessert', 'yoghurt', 'yogurt',
}

def cheese_name_words(name):
    words = search_words(name)
    # "Revet ost til pizza" is cheese with a serving suggestion.
    # "Pizza med revet ost" must still be rejected.
    for i, word in enumerate(words):
        if word in ('til', 'for') and any(x in CHEESE_WORDS for x in words[:i]):
            return words[:i]
    return words

# Conservative cheese mode: every name token must be understood. Unknown
# names are omitted rather than treated as cheese just because they contain ost.
CHEESE_NAME_CONTEXT = {
    'tine','synnøve','finden','arla','castello','président','president','kavli',
    'galbani','apetina','kolonihagen','coop','xtra','first','price','eldorado',
    'rema','r','b','f','økologisk','øko','økologiske','organic','original',
    'lett','lettere','light','mager','mild','milde','lagret','vellagret','ekstra',
    'modnet','moden','vintage','reserve','classic','klassisk','naturell',
    'skivet','skiver','revet','raspet','hel','bit','blokk','terninger','biter',
    'skive','skjært','finrevet','grovrevet','skjæreost','fastost','ferskost',
    'cottage','cream','cheddar','norsk','norske','dansk','danske','fransk',
    'italiensk','spansk','hvit','hvitløk','urter','krydder','pepper','chili',
    'jalapeno','jalapeño','jalapeo','paprika','gressløk','soltørket','tomat',
    'tomater','trøffel','basilikum','med','m','og','i','lake','olje','uten',
    'laktose','laktosefri','fett','salt','usaltet','saltet','røkt','røktost',
    'g','gr','gram','kg','kilo','stk','pk','pakk','pakke','pakning','stykker',
    'tub','tube','beger','pose','skorpe','rød','sort','svart','blå','gul',
    'grill','grilling','bacon','skinke','salami',
}
PREPARED_ENDINGS = ('pølse','pølser','burger','burgere','chips','kjeks',
                    'pizza','baguette','baguetter','snurr','snurrer','saus',
                    'suppe','supper','grateng','sandwich','wrap','wraps',
                    'kake','kaker','brød','bolle','boller','horn','salat','grøt',
                    'pudding','frokostblanding','müsli','musli')

def is_prepared_word(word):
    return word in PREPARED_FOODS or word.endswith(PREPARED_ENDINGS)

def is_cheese_product(name):
    words = cheese_name_words(name)
    if not any(word in CHEESE_WORDS for word in words): return False
    first_cheese = next(i for i,w in enumerate(words) if w in CHEESE_WORDS)
    for i, word in enumerate(words):
        if word in CHEESE_WORDS: continue
        if is_prepared_word(word):
            # Cream cheese with bacon is still a cheese product.
            if word in ('bacon','skinke','salami') and i > first_cheese and any(w in ('med','m') for w in words[first_cheese:i]): continue
            return False
        if word not in CHEESE_NAME_CONTEXT and not re.fullmatch(r'\d+(?:x\d+)*(?:g|gr|kg|stk|pk)?',word):
            return False
    if any(w in ('med','m','fylt','fylte','fyll','smak','smaken') for w in words[:first_cheese]): return False
    return True

MILK_WORDS = {'melk', 'mjølk'} | FOOD_COMPOUNDS['melk']
MILK_NAME_CONTEXT = {
    'tine','q','qmelk','qmeieriene','qmeierienes','qmeieriet','qmeieria',
    'qmeieriene','meieriene','røros','rørosmeieriet','rørosmeieriets','arla',
    'coop','xtra','first','price','eldorado','kolonihagen','rema','r',
    'alpro','oatly','go','vegan','anglamark','änglamark',
    'lett','hel','heil','skummet','skumma','ekstra','fett','fettfri',
    'økologisk','øko','organic','original','naturell','norsk','norske',
    'laktosefri','laktoseredusert','laktose','uten','med','m','og',
    'd','vitamin','vitaminer','vitaminberiket','beriket','kalsium','protein',
    'langtidsholdbar','langtidsholdbarhet','uht','pasteurisert','homogenisert',
    'fersk','barista','kaffe','sjokolade','kakao','vanilje','jordbær','banan',
    'smak','av','smaksatt','sukker','tilsatt','usøtet','søtet',
    'l','liter','litre','ltr','dl','ml','cl','g','kg','stk','pk','pakke','kartong',
}

def is_milk_product(name):
    words = search_words(name)
    if not any(word in MILK_WORDS for word in words): return False
    first_milk = next(i for i,w in enumerate(words) if w in MILK_WORDS)
    if any(w in ('med','m','fylt','fylte','smak') for w in words[:first_milk]): return False
    return all(word in MILK_WORDS or word in MILK_NAME_CONTEXT or
               re.fullmatch(r'\d+(?:x\d+)*(?:ml|cl|dl|l|g|kg|stk|pk)?',word)
               for word in words)

# Butter searches mean the product itself, not butter as an ingredient.
# Blended spreads (e.g. Bremykt), margarine and nut butters are not dairy butter.
BUTTER_WORDS = {'smør', 'meierismør', 'setersmør', 'sætersmør',
                'rørossmør', 'kviteseidsmør', 'klarnet'}
BUTTER_NAME_CONTEXT = {
    'tine', 'røros', 'rørosmeieriet', 'rørosmeieriets', 'kviteseid',
    'arla', 'lurpak', 'président', 'president', 'kolonihagen', 'coop',
    'xtra', 'first', 'price', 'eldorado', 'rema', 'r', 'änglamark',
    'anglamark', 'økologisk', 'øko', 'organic', 'original', 'ekte',
    'norsk', 'norske', 'dansk', 'fransk', 'saltet', 'usaltet',
    'lettsaltet', 'normalsaltet', 'salt', 'havsalt', 'flaksalt',
    'syrnet', 'kjernet', 'tradisjonelt', 'tradisjonell', 'laktosefri',
    'uten', 'med', 'm', 'og', 'ekstra', 'fett', 'g', 'gr', 'gram',
    'kg', 'kilo', 'stk', 'pk', 'pakke', 'pakning', 'beger', 'boks',
    'rull', 'kuvert', 'porsjon', 'porsjoner',
}
BUTTER_PRODUCTS = BUTTER_WORDS - {'klarnet'}

def is_butter_product(name):
    words = search_words(name)
    if not any(word in BUTTER_PRODUCTS for word in words): return False
    first = next(i for i, word in enumerate(words) if word in BUTTER_PRODUCTS)
    if any(word in ('med', 'm', 'av', 'smak', 'fylt', 'fylte')
           for word in words[:first]): return False
    return all(word in BUTTER_WORDS or word in BUTTER_NAME_CONTEXT or
               re.fullmatch(r'\d+(?:x\d+)*(?:g|gr|kg|stk|pk)?', word)
               for word in words)

def butter_query_intent(terms):
    # An explicit other product type ("popcorn med smør", "kjeks smør")
    # keeps the normal name search. Unknown additions are kept strict.
    other_types = {'popcorn', 'mikropopcorn', 'smørpopcorn', 'peanøttsmør',
                   'mandelsmør', 'nøttesmør', 'margarin', 'bremykt', 'brelett'}
    return any(term in BUTTER_PRODUCTS for term in terms) and not any(
        is_prepared_word(term) or term in other_types for term in terms)

def search_score(name, query):
    words, terms = search_words(name), search_words(query)
    if not terms: return None
    if butter_query_intent(terms) and not is_butter_product(name): return None
    cheese_intent = any(term in CHEESE_WORDS for term in terms) and not any(
        is_prepared_word(term) for term in cheese_name_words(query))
    if cheese_intent and not is_cheese_product(name): return None
    milk_intent = any(term in MILK_WORDS for term in terms) and not any(is_prepared_word(term) for term in terms)
    if milk_intent and not is_milk_product(name): return None
    score = 0
    for term in terms:
        if term in words:
            score += 100
        elif any(word in FOOD_COMPOUNDS.get(term, set()) for word in words):
            score += 90
        elif term != 'ost' and len(term) >= 3 and any(word.startswith(term) for word in words):
            score += 60
        else:
            return None
    if words[:len(terms)] == terms: score += 20
    return score

def api(path, query):
    if path=='/api/status': return {'configured':bool(KEY)}
    if path=='/api/products':
        q=query.get('q',[''])[0].strip(); store=query.get('store',[''])[0]
        if not 3<=len(q)<=100: raise ApiError(400,'Skriv mellom 3 og 100 tegn.')
        args={'search':q,'size':100,'unique':'0'}
        if store:
            if store not in STORES: raise ApiError(400,'Butikken har ingen bekreftet API-kobling.')
            args['store']=store
        data=fetch('/products?'+urlencode(args))
        products=[]
        for x in data.get('data',[]):
            if not isinstance(x,dict): continue
            p=normalize(x)
            if not p: continue
            relevance=search_score(p['name'],q)
            if relevance is not None:
                p['relevance']=relevance
                products.append(p)
        products.sort(key=lambda p: (-p['relevance'], p['price'] if p['price'] is not None else math.inf))
        return {'products':products,'limited':bool((data.get('links') or {}).get('next')),'source':'Kassalapp'}
    if path=='/api/compare':
        ean=query.get('ean',[''])[0]
        if not re.fullmatch(r'\d{8,14}',ean): raise ApiError(400,'Ugyldig strekkode.')
        data=fetch('/products/ean/'+ean).get('data') or {}
        return {'products':[p for x in data.get('products',[]) if isinstance(x,dict) and (p:=normalize(x,ean))],'source':'Kassalapp'}
    raise ApiError(404,'Ukjent API-adresse.')

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def allowed_origins(self):
        origins={f'http://localhost:{self.server.server_port}',f'http://127.0.0.1:{self.server.server_port}'}
        public=os.environ.get('SAVLY_PUBLIC_ORIGIN','').rstrip('/')
        if public:origins.add(public)
        return origins
    def valid_origin(self):
        allowed=self.allowed_origins()
        if self.headers.get('Host') not in {urlsplit(x).netloc for x in allowed}:return False
        origin=self.headers.get('Origin')
        return not origin or origin in allowed
    def send(self,status,body,kind='application/json; charset=utf-8'):
        raw=json.dumps(body,ensure_ascii=False).encode() if isinstance(body,dict) else body
        self.send_response(status);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(raw)))
        self.send_header('X-Content-Type-Options','nosniff');self.send_header('Cache-Control','no-store')
        self.send_header('Referrer-Policy','no-referrer');self.send_header('X-Frame-Options','DENY')
        self.send_header('Cross-Origin-Opener-Policy','same-origin-allow-popups')
        token=getattr(self,'session_token',None)
        if token:
            secure='; Secure' if os.environ.get('SAVLY_PUBLIC_ORIGIN','').startswith('https://') else ''
            self.send_header('Set-Cookie','savly_session='+token+'; Path=/; HttpOnly; SameSite=Lax'+secure)
        self.end_headers();self.wfile.write(raw)
    def household(self,method,path,body):
        data,token=households.handle(method,path,body,self.headers.get('Cookie'),self.headers.get('X-SAVLY-CSRF'),self.client_address[0])
        self.session_token=token
        return self.send(200,data)
    def do_POST(self):
        if not self.valid_origin():return self.send(403,{'error':'Ugyldig opphav.'})
        try:
            length=int(self.headers.get('Content-Length','0'))
            if length<2 or length>1100000:return self.send(413,{'error':'Forespørselen er for stor eller tom.'})
            if self.headers.get('Content-Type','').split(';')[0]!='application/json':return self.send(415,{'error':'Forventet JSON.'})
            body=json.loads(self.rfile.read(length))
            if not isinstance(body,dict):return self.send(400,{'error':'Ugyldig forespørsel.'})
            return self.household('POST',urlsplit(self.path).path,body)
        except households.HouseholdError as e:return self.send(e.status,{'error':e.message})
        except (ValueError,TypeError):return self.send(400,{'error':'Ugyldige data.'})
        except Exception:return self.send(500,{'error':'Kunne ikke lagre endringen. Prøv igjen.'})
    def do_GET(self):
        if not self.valid_origin():return self.send(403,{'error':'Ugyldig opphav.'})
        part=urlsplit(self.path)
        try:
            if part.path in ('/api/session','/api/household'):return self.household('GET',part.path,{})
            if part.path.startswith('/api/'):return self.send(200,api(part.path,parse_qs(part.query)))
            files={'/':('SAVLY.html','text/html; charset=utf-8'),'/SAVLY.html':('SAVLY.html','text/html; charset=utf-8'),'/receipt.js':('receipt.js','text/javascript; charset=utf-8'),'/prices.js':('prices.js','text/javascript; charset=utf-8'),'/household.js':('household.js','text/javascript; charset=utf-8'),'/onboarding.css':('onboarding.css','text/css; charset=utf-8'),'/savly_wordmark_blue.png':('savly_wordmark_blue.png','image/png')}
            if part.path not in files:return self.send(404,{'error':'Fant ikke siden.'})
            name,kind=files[part.path];return self.send(200,(ROOT/name).read_bytes(),kind)
        except (ApiError,households.HouseholdError) as e:return self.send(e.status,{'error':e.message})
        except Exception:return self.send(502,{'error':'Kunne ikke behandle data.'})

if __name__=='__main__':
    if not KEY: KEY=getpass.getpass('Kassalapp API-nøkkel (skjult, Enter hopper over prissøk): ').strip()
    port=int(os.environ.get('PORT','8787'))
    households.init_db()
    host='0.0.0.0' if os.environ.get('PORT') or os.environ.get('SAVLY_PUBLIC_ORIGIN') else '127.0.0.1'
    print(f'Åpne http://localhost:{port} — avslutt med Ctrl+C. Nøkkelen lagres ikke.')
    if os.environ.get('SAVLY_PUBLIC_ORIGIN'):print('Delt adresse: '+os.environ['SAVLY_PUBLIC_ORIGIN'])
    ThreadingHTTPServer((host,port),Handler).serve_forever()
