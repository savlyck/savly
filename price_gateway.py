"""Server-side SAVLY price source adapter. Frontend never sees credentials."""
import json
import os
import threading
import time
import urllib.error
import urllib.request

class ApiError(Exception):
    def __init__(self,status,message):
        self.status,self.message=status,message

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,request,fp,code,msg,headers,newurl):
        raise ApiError(502,'Datakilden svarte med en uventet omdirigering.')

class KassalappProvider:
    name='Kassalapp'
    def __init__(self):
        self.base='https://kassal.app/api/v1'
        self.minute=max(1,int(os.environ.get('KASSALAPP_REQUESTS_PER_MINUTE','50')))
        self.hour=max(1,int(os.environ.get('KASSALAPP_REQUESTS_PER_HOUR','1000')))
        self.cache={}
        self.requests=[]
        self.lock=threading.Lock()
        self.slots=threading.BoundedSemaphore(4)
    def fetch(self,path,key):
        if not key:raise ApiError(503,'API-nøkkel mangler på serveren.')
        now=time.monotonic()
        with self.lock:
            record=self.cache.get(path)
            if record and now-record[0]<300:return record[1]
            self.requests[:]=[t for t in self.requests if now-t<3600]
            if len(self.requests)>=self.hour or sum(now-t<60 for t in self.requests)>=self.minute:
                raise ApiError(429,'Mange prissøk. Vent litt og prøv igjen.')
            self.requests.append(now)
        if not self.slots.acquire(blocking=False):raise ApiError(429,'Prissøk pågår. Prøv igjen om litt.')
        try:
            req=urllib.request.Request(self.base+path,headers={'Authorization':'Bearer '+key,'Accept':'application/json'})
            with urllib.request.build_opener(NoRedirect()).open(req,timeout=15) as response:
                raw=response.read(5_000_001)
                if len(raw)>5_000_000:raise ApiError(502,'Svaret fra datakilden er for stort.')
                data=json.loads(raw)
            with self.lock:
                if len(self.cache)>=150:self.cache.pop(next(iter(self.cache)))
                self.cache[path]=(now,data)
            return data
        except urllib.error.HTTPError as e:
            status=429 if e.code==429 else 502
            messages={400:'Priskilden avviste søket (400).',401:'Priskilden avviste API-nøkkelen (401).',
                      403:'API-tilgangen tillater ikke dette søket (403).',
                      404:'Ingen data funnet hos priskilden (404).',
                      422:'Priskilden avviste parameterne (422).',
                      429:'Forespørselsgrensen er nådd (429).'}
            raise ApiError(status,messages.get(e.code,'Priskilden svarte med feil. Prøv igjen senere.'))
        except (urllib.error.URLError,TimeoutError,ValueError):
            raise ApiError(502,'Kunne ikke hente priser. Prøv igjen senere.')
        finally:
            self.slots.release()

PROVIDER_NAME=os.environ.get('SAVLY_PRICE_PROVIDER','kassalapp').strip().lower()
PROVIDER=KassalappProvider() if PROVIDER_NAME=='kassalapp' else None

def configured(key):
    return PROVIDER is not None and bool(key)

def fetch(path,key):
    if PROVIDER is None:
        raise ApiError(503,'Prisleverandøren er ikke konfigurert. Ukeplan og handleliste fungerer fortsatt.')
    return PROVIDER.fetch(path,key)
