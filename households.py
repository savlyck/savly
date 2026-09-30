"""Household membership, transient browser sessions and transactional shared data."""
import copy, hashlib, json, os, re, secrets, sqlite3, threading, time, logging
from pathlib import Path
from http.cookies import SimpleCookie

DB_PATH = os.environ.get('SAVLY_DB', str(Path(__file__).resolve().parent/'savly.sqlite3'))
GOOGLE_CLIENT_ID = os.environ.get('GOOGLE_CLIENT_ID', '').strip()
SESSIONS, ATTEMPTS = {}, {}
LOCK = threading.RLock()
INIT_LOCK = threading.Lock()
INITIALIZED = False
KINDS = ('list','fridge','meals')
EMPTY = {k:[] for k in KINDS}

class ClosingConnection(sqlite3.Connection):
    def __exit__(self, *args):
        try: return super().__exit__(*args)
        finally: self.close()

class HouseholdError(Exception):
    def __init__(self, status, message, code=None): self.status, self.message, self.code = status, message, code

def init_db():
    global INITIALIZED
    with INIT_LOCK:
        if INITIALIZED: return
        with sqlite3.connect(DB_PATH,factory=ClosingConnection) as db:
            db.executescript('''
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,provider TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS homes(id TEXT PRIMARY KEY,name TEXT NOT NULL,size INTEGER NOT NULL,owner TEXT NOT NULL,code TEXT UNIQUE NOT NULL,expires REAL NOT NULL,data TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS accounts(user_id TEXT PRIMARY KEY,data TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,created_at REAL NOT NULL,last_login REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS members(user_id TEXT PRIMARY KEY,home_id TEXT NOT NULL,joined REAL NOT NULL);
            ''')
            db.execute("DELETE FROM members WHERE user_id IN (SELECT id FROM users WHERE provider='demo')")
            db.execute("DELETE FROM users WHERE provider='demo'")
            clean_homes(db)
        INITIALIZED = True

def clean_homes(db):
    db.execute('DELETE FROM homes WHERE id NOT IN (SELECT home_id FROM members)')
    for home in db.execute('SELECT id,owner FROM homes').fetchall():
        if not db.execute('SELECT 1 FROM members WHERE user_id=? AND home_id=?',(home[1],home[0])).fetchone():
            owner=db.execute('SELECT user_id FROM members WHERE home_id=? ORDER BY joined LIMIT 1',(home[0],)).fetchone()
            if owner:db.execute('UPDATE homes SET owner=? WHERE id=?',(owner[0],home[0]))

def connection():
    init_db(); db=sqlite3.connect(DB_PATH,timeout=10,factory=ClosingConnection);db.row_factory=sqlite3.Row;return db

def forget_demo(user):
    if user and user.get('provider')=='demo':
        with connection() as db:
            db.execute('DELETE FROM members WHERE user_id=?',(user['id'],))
            db.execute('DELETE FROM users WHERE id=?',(user['id'],));clean_homes(db)

def session(cookie_header):
    token=''
    try:
        cookie=SimpleCookie();cookie.load(cookie_header or '');token=cookie['savly_session'].value if 'savly_session' in cookie else ''
    except Exception:pass
    with LOCK:
        now=time.time()
        for old in [k for k,v in SESSIONS.items() if v['expires']<now]:
            forget_demo(SESSIONS[old].get('user'));del SESSIONS[old]
        if token not in SESSIONS:
            token=secrets.token_urlsafe(32)
            SESSIONS[token]={'csrf':secrets.token_urlsafe(32),'nonce':secrets.token_urlsafe(32),'expires':now+86400,'user':None}
        return token,SESSIONS[token]

def rotate(token, user):
    with LOCK:
        SESSIONS.pop(token,None)
        new=secrets.token_urlsafe(32)
        SESSIONS[new]={'csrf':secrets.token_urlsafe(32),'nonce':secrets.token_urlsafe(32),'expires':time.time()+86400,'user':user}
        return new,SESSIONS[new]

def limit(key,maximum,seconds):
    with LOCK:
        now=time.time()
        if len(ATTEMPTS)>5000:
            for k in list(ATTEMPTS):
                if not ATTEMPTS[k] or now-ATTEMPTS[k][-1]>3600: ATTEMPTS.pop(k,None)
        entries=ATTEMPTS.setdefault(key,[]);entries[:]=[t for t in entries if now-t<seconds]
        if len(entries)>=maximum:raise HouseholdError(429,'For mange forsøk. Vent noen minutter.')
        entries.append(now)

def text(value, label, maximum=80):
    if not isinstance(value,str) or not 1<=len(value.strip())<=maximum:raise HouseholdError(400,'Skriv inn '+label+'.')
    return value.strip()

def size(value):
    if type(value) is not int or not 1<=value<=30:raise HouseholdError(400,'Velg mellom 1 og 30 personer.')
    return value

def validate_data(data):
    if not isinstance(data,dict) or set(data)!=set(KINDS):raise HouseholdError(400,'Ugyldige delte data.')
    for kind in KINDS:
        if not isinstance(data[kind],list) or len(data[kind])>1000:raise HouseholdError(400,'For mange elementer.')
        ids=set()
        for item in data[kind]:
            if not isinstance(item,dict):raise HouseholdError(400,'Ugyldig element.')
            ident=item.get('id')
            if not isinstance(ident,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}',ident) or ident in ids:raise HouseholdError(400,'Ugyldig eller gjentatt element-ID.')
            ids.add(ident)
            text(item.get('title' if kind=='meals' else 'name'),'varenavn',200)
            if kind=='meals':
                if not isinstance(item.get('date'),str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}',item['date']):raise HouseholdError(400,'Ugyldig måltidsdato.')
                if item.get('type') not in ('breakfast','lunch','dinner','other'):raise HouseholdError(400,'Ugyldig måltidstype.')
    if len(json.dumps(data,ensure_ascii=False))>500000:raise HouseholdError(413,'Husstanden har for mye data.')
    return data

def merge_data(base, local, remote):
    """Three-way merge: independent rows/fields merge; conflicting edits never overwrite."""
    result=copy.deepcopy(remote)
    missing=object()
    for kind in KINDS:
        before={x['id']:x for x in base[kind]};after={x['id']:x for x in local[kind]};current={x['id']:x for x in remote[kind]}
        for ident in set(before)|set(after):
            b,l,r=before.get(ident,missing),after.get(ident,missing),current.get(ident,missing)
            if l==b or l==r:continue
            if r==b:
                if l is missing:current.pop(ident,None)
                else:current[ident]=copy.deepcopy(l)
                continue
            if b is missing or l is missing or r is missing:
                raise HouseholdError(409,'Noen andre endret samme vare eller måltid. Endringen din er beholdt på skjermen.')
            merged=copy.deepcopy(r)
            for field in set(b)|set(l):
                bv,lv,rv=b.get(field,missing),l.get(field,missing),r.get(field,missing)
                if lv==bv or lv==rv:continue
                if rv!=bv:raise HouseholdError(409,'Noen andre endret samme felt. Endringen din er beholdt på skjermen.')
                if lv is missing:merged.pop(field,None)
                else:merged[field]=copy.deepcopy(lv)
            current[ident]=merged
        result[kind]=list(current.values())
    return validate_data(result)

def get_home(db,user):
    return db.execute('SELECT h.* FROM homes h JOIN members m ON m.home_id=h.id WHERE m.user_id=?',(user['id'],)).fetchone()

def home_view(db,user):
    row=get_home(db,user)
    if not row:return None
    members=[{'id':r['id'],'name':r['name'],'owner':r['id']==row['owner']} for r in db.execute('SELECT u.id,u.name FROM users u JOIN members m ON m.user_id=u.id WHERE m.home_id=? ORDER BY m.joined',(row['id'],))]
    return {'id':row['id'],'name':row['name'],'size':row['size'],'members':members,'owner':row['owner']==user['id'],
        'code':row['code'] if row['expires']>time.time() else None,'codeExpires':row['expires'],'data':json.loads(row['data']),'revision':row['revision']}


def default_account():
    return {'personal':copy.deepcopy(EMPTY),'prefs':{'diet':[],'allergies':[],'householdSize':1,'favoriteStores':['rem','kiwi','extra'],'favoriteItems':[],'onboarded':False},'budget':2500,'purchases':[],'suggestions':[],'storeFilter':{'rem':True,'kiwi':True,'extra':True}}

def account_view(db,user):
    if not user or user.get('provider')!='google':return None
    row=db.execute('SELECT * FROM accounts WHERE user_id=?',(user['id'],)).fetchone()
    return {'data':json.loads(row['data']),'revision':row['revision']} if row else None

def validate_account(data):
    if not isinstance(data,dict) or set(data)!=set(default_account()):raise HouseholdError(400,'Ugyldige kontodata.')
    validate_data(data['personal'])
    if type(data['budget']) not in (int,float) or not 0<data['budget']<=1000000:raise HouseholdError(400,'Ugyldig budsjett.')
    prefs=data['prefs']
    if not isinstance(prefs,dict) or len(prefs)>40:raise HouseholdError(400,'Ugyldige preferanser.')
    for key in ('diet','allergies','favoriteStores','favoriteItems'):
        values=prefs.get(key,[])
        if not isinstance(values,list) or len(values)>100 or any(not isinstance(v,str) or len(v)>200 for v in values):raise HouseholdError(400,'Ugyldige preferanser.')
    if type(prefs.get('onboarded',False)) is not bool:raise HouseholdError(400,'Ugyldig oppsettstatus.')
    if 'householdSize' in prefs:size(prefs['householdSize'])
    for key in ('purchases','suggestions'):
        if not isinstance(data[key],list) or len(data[key])>2000 or any(not isinstance(v,dict) for v in data[key]):raise HouseholdError(400,'For mange eller ugyldige notater.')
    if not isinstance(data['storeFilter'],dict) or len(data['storeFilter'])>100 or any(type(v) is not bool for v in data['storeFilter'].values()):raise HouseholdError(400,'Ugyldig butikkfilter.')
    try:encoded=json.dumps(data,allow_nan=False)
    except (ValueError,TypeError):raise HouseholdError(400,'Ugyldige kontodata.')
    if len(encoded)>700000:raise HouseholdError(413,'Kontoen har for mye data.')
    return encoded

def google_ready():
    if not GOOGLE_CLIENT_ID:return False
    try:from google.oauth2 import id_token;from google.auth.transport import requests
    except ImportError:return False
    return True

def verify_google(credential, nonce):
    if not google_ready():raise HouseholdError(503,'Google-innlogging er ikke konfigurert på serveren.')
    from google.oauth2 import id_token
    from google.auth.transport import requests
    try:
        claims=id_token.verify_oauth2_token(credential,requests.Request(),GOOGLE_CLIENT_ID)
        if claims.get('iss') not in ('accounts.google.com','https://accounts.google.com') or claims.get('aud')!=GOOGLE_CLIENT_ID:raise ValueError()
        if not isinstance(claims.get('nonce'),str) or not secrets.compare_digest(claims['nonce'],nonce):raise ValueError()
        if not claims.get('sub'):raise ValueError()
    except Exception:raise HouseholdError(401,'Google-innlogging kunne ikke bekreftes. Prøv igjen.')
    return {'id':'g_'+hashlib.sha256(claims['sub'].encode()).hexdigest(),'name':str(claims.get('given_name') or claims.get('name') or 'Bruker')[:80],'provider':'google'}

def handle(method,path,body,cookie,csrf,ip):
    token,sess=session(cookie)
    if method!='GET':
        if not isinstance(csrf,str) or not secrets.compare_digest(csrf,sess['csrf']):
            # Log classifications only: no cookies, tokens, user IDs or credentials.
            supplied=''
            try:
                parsed=SimpleCookie();parsed.load(cookie or '')
                supplied=parsed['savly_session'].value if 'savly_session' in parsed else ''
            except Exception:pass
            reason='cookie_missing' if not supplied else 'session_unknown' if supplied!=token else 'csrf_mismatch'
            logging.warning('SAVLY session rejected: %s',reason)
            raise HouseholdError(403,'Økten må fornyes.','SESSION_STALE')
        limit('write:'+ip,120,60)
    if path=='/api/session' and method=='GET':
        user=sess.get('user')
        with connection() as db:
            return {'csrf':sess['csrf'],'nonce':sess['nonce'],'googleClientId':GOOGLE_CLIENT_ID if google_ready() else None,'user':user,'home':home_view(db,user) if user else None,'account':account_view(db,user)},token
    if path in ('/api/auth/demo','/api/auth/google') and method=='POST':
        limit('auth:'+ip,20,600)
        if path.endswith('demo'):
            user={'id':'d_'+secrets.token_urlsafe(18),'name':text(body.get('name'),'navn'),'provider':'demo'}
        else:user=verify_google(text(body.get('credential'),'Google-token',10000),sess['nonce'])
        forget_demo(sess.get('user'))
        with connection() as db:
            db.execute('INSERT INTO users VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name',(user['id'],user['name'],user['provider']))
            if user['provider']=='google':
                now=time.time()
                db.execute('INSERT INTO accounts(user_id,data,created_at,last_login) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET last_login=excluded.last_login',(user['id'],json.dumps(default_account()),now,now))
            account=account_view(db,user)
            home=home_view(db,user)
        token,sess=rotate(token,user)
        return {'user':user,'home':home,'account':account,'csrf':sess['csrf'],'nonce':sess['nonce']},token
    if path=='/api/auth/logout' and method=='POST':
        forget_demo(sess.get('user'));token,sess=rotate(token,None)
        return {'csrf':sess['csrf'],'nonce':sess['nonce']},token
    user=sess.get('user')
    if not user:raise HouseholdError(401,'Logg inn før du bruker husstand.')
    with connection() as db:
        if path=='/api/account':
            if user['provider']!='google':raise HouseholdError(403,'Kontolagring krever Google-innlogging.')
            if method=='GET':return {'account':account_view(db,user)},token
            if method=='POST':
                encoded=validate_account(body.get('data'))
                revision=body.get('revision')
                if type(revision) is not int or revision<0:raise HouseholdError(400,'Ugyldig versjon.')
                db.execute('BEGIN IMMEDIATE')
                result=db.execute('UPDATE accounts SET data=?,revision=revision+1 WHERE user_id=? AND revision=?',(encoded,user['id'],revision))
                if result.rowcount!=1:raise HouseholdError(409,'Kontoen er endret på en annen enhet. Last ned din kopi før du henter den lagrede versjonen.')
                return {'account':account_view(db,user)},token
        if method=='GET' and path=='/api/household':return {'home':home_view(db,user)},token
        db.execute('BEGIN IMMEDIATE')
        row=get_home(db,user)
        if path=='/api/household/create' and method=='POST':
            if row:raise HouseholdError(409,'Du er allerede med i en husstand.')
            name=text(body.get('name'),'navn på husstanden');count=size(body.get('size'))
            data=validate_data(body.get('data',copy.deepcopy(EMPTY)))
            ident=secrets.token_urlsafe(18);code=secrets.token_hex(5).upper()
            db.execute('INSERT INTO homes(id,name,size,owner,code,expires,data) VALUES(?,?,?,?,?,?,?)',(ident,name,count,user['id'],code,time.time()+7*86400,json.dumps(data)))
            db.execute('INSERT INTO members VALUES(?,?,?)',(user['id'],ident,time.time()))
        elif path=='/api/household/join' and method=='POST':
            if row:raise HouseholdError(409,'Forlat nåværende husstand før du blir med i en annen.')
            limit('join:'+ip,10,600)
            code=text(body.get('code'),'invitasjonskode',20).upper().replace(' ','').replace('-','')
            target=db.execute('SELECT * FROM homes WHERE code=? AND expires>?',(code,time.time())).fetchone()
            if not target:raise HouseholdError(404,'Koden er ugyldig eller utløpt. Be om en ny invitasjon.')
            if db.execute('SELECT count(*) FROM members WHERE home_id=?',(target['id'],)).fetchone()[0]>=30:raise HouseholdError(409,'Husstanden har nådd medlemsgrensen.')
            db.execute('INSERT INTO members VALUES(?,?,?)',(user['id'],target['id'],time.time()))
        elif path=='/api/household/sync' and method=='POST':
            if not row or body.get('homeId')!=row['id']:raise HouseholdError(403,'Du har ikke tilgang til denne husstanden.')
            data=merge_data(validate_data(body.get('base')),validate_data(body.get('data')),json.loads(row['data']))
            db.execute('UPDATE homes SET data=?,revision=revision+1 WHERE id=?',(json.dumps(data),row['id']))
        elif path=='/api/household/leave' and method=='POST':
            if row:db.execute('DELETE FROM members WHERE user_id=?',(user['id'],));clean_homes(db)
        elif path in ('/api/household/update','/api/household/rotate') and method=='POST':
            if not row or row['owner']!=user['id']:raise HouseholdError(403,'Bare den som administrerer husstanden kan gjøre dette.')
            if path.endswith('rotate'):db.execute('UPDATE homes SET code=?,expires=? WHERE id=?',(secrets.token_hex(5).upper(),time.time()+7*86400,row['id']))
            else:db.execute('UPDATE homes SET name=?,size=? WHERE id=?',(text(body.get('name'),'navn'),size(body.get('size')),row['id']))
        else:raise HouseholdError(404,'Ukjent handling.')
        return {'home':home_view(db,user)},token
