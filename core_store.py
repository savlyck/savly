"""SAVLY v2 storage. Additive, per-account or authorized shared-household data."""
import copy
import json
import re
import secrets
import time
import households

KINDS = ('meals', 'list', 'pantry', 'favorites')
DEFAULT = {'meals': [], 'list': [], 'pantry': [], 'favorites': [],
           'prefs': {'people': 1, 'allergies': [], 'onboarded': False}}
MAX_BYTES = 400_000

def validate(data):
    if not isinstance(data, dict) or set(data) != set(DEFAULT):
        raise households.HouseholdError(400, 'Ugyldig datamodell.')
    for kind in KINDS:
        values = data[kind]
        if not isinstance(values, list) or len(values) > 1000:
            raise households.HouseholdError(400, 'For mange eller ugyldige elementer.')
        ids = set()
        for item in values:
            if not isinstance(item, dict):
                raise households.HouseholdError(400, 'Ugyldig element.')
            ident = item.get('id')
            if not isinstance(ident, str) or not re.fullmatch(r'[\w-]{1,80}', ident, re.ASCII) or ident in ids:
                raise households.HouseholdError(400, 'Ugyldig eller gjentatt ID.')
            ids.add(ident)
            label = item.get('title') if kind in ('meals', 'favorites') else item.get('name')
            if not isinstance(label, str) or not 1 <= len(label.strip()) <= 200:
                raise households.HouseholdError(400, 'Varen mangler navn.')
            if kind == 'meals':
                if not isinstance(item.get('date'), str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', item['date']):
                    raise households.HouseholdError(400, 'Ugyldig dato.')
                if not isinstance(item.get('ingredients', []), list) or len(item.get('ingredients', [])) > 100:
                    raise households.HouseholdError(400, 'For mange ingredienser.')
    prefs = data['prefs']
    if not isinstance(prefs, dict) or not 1 <= prefs.get('people', 0) <= 30 or type(prefs.get('people')) is not int:
        raise households.HouseholdError(400, 'Ugyldig antall personer.')
    if not isinstance(prefs.get('allergies', []), list) or len(prefs['allergies']) > 30 or any(not isinstance(a, str) or len(a) > 100 for a in prefs['allergies']):
        raise households.HouseholdError(400, 'Ugyldige preferanser.')
    try:
        packed = json.dumps(data, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError):
        raise households.HouseholdError(400, 'Ugyldige dataverdier.')
    if len(packed.encode()) > MAX_BYTES:
        raise households.HouseholdError(413, 'Datamengden er for stor.')
    return packed

def merge(base, local, remote):
    """Three-way merge by stable IDs and fields. Conflicts are explicit, never discarded."""
    missing = object()
    result = copy.deepcopy(remote)
    for kind in KINDS:
        prior = {x['id']: x for x in base[kind]}
        changed = {x['id']: x for x in local[kind]}
        current = {x['id']: x for x in remote[kind]}
        for ident in set(prior) | set(changed):
            b, l, r = prior.get(ident, missing), changed.get(ident, missing), current.get(ident, missing)
            if l == b or l == r:
                continue
            if r == b:
                if l is missing:
                    current.pop(ident, None)
                else:
                    current[ident] = copy.deepcopy(l)
                continue
            if b is missing or l is missing or r is missing:
                raise households.HouseholdError(409, 'Samme element ble endret på flere enheter. Lokale endringer er bevart.')
            updated = copy.deepcopy(r)
            for field in set(b) | set(l):
                old, new, server = b.get(field, missing), l.get(field, missing), r.get(field, missing)
                if new == old or new == server:
                    continue
                if server != old:
                    raise households.HouseholdError(409, 'Samme felt ble endret på flere enheter. Lokale endringer er bevart.')
                if new is missing:
                    updated.pop(field, None)
                else:
                    updated[field] = copy.deepcopy(new)
            current[ident] = updated
        result[kind] = list(current.values())
    for key in set(base['prefs']) | set(local['prefs']):
        old, new, server = base['prefs'].get(key, missing), local['prefs'].get(key, missing), remote['prefs'].get(key, missing)
        if new == old or new == server:
            continue
        if server != old:
            raise households.HouseholdError(409, 'Innstillingen ble endret på en annen enhet.')
        if new is missing:
            result['prefs'].pop(key, None)
        else:
            result['prefs'][key] = copy.deepcopy(new)
    validate(result)
    return result

def _owner(db, user, scope):
    if scope == 'personal':
        return 'user:' + user['id']
    if scope != 'household':
        raise households.HouseholdError(400, 'Ukjent lagringsområde.')
    home = households.get_home(db, user)
    if not home:
        raise households.HouseholdError(403, 'Du tilhører ikke en delt husstand.')
    return 'home:' + home['id']

def _view(db, owner):
    db.execute('''CREATE TABLE IF NOT EXISTS core_documents (
      owner TEXT PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0
    )''')
    row = db.execute('SELECT data, revision FROM core_documents WHERE owner=?', (owner,)).fetchone()
    if row:
        return {'data': json.loads(row['data']), 'revision': row['revision']}
    return {'data': copy.deepcopy(DEFAULT), 'revision': 0}

def handle(method, body, cookie, csrf, scope='personal'):
    token, sess = households.session(cookie)
    user = sess.get('user')
    if not user or user.get('provider') != 'google':
        raise households.HouseholdError(401, 'Logg inn med Google for å synkronisere. Gjestedata er lagret på enheten.')
    if method == 'POST' and (not isinstance(csrf, str) or not secrets.compare_digest(csrf, sess['csrf'])):
        raise households.HouseholdError(403, 'Økten ble endret. Hent øktinformasjon og prøv igjen.', 'SESSION_STALE')
    with households.connection() as db:
        owner = _owner(db, user, scope)
        if method == 'GET':
            return {**_view(db, owner), 'scope': scope, 'user': {'name': user['name'], 'id': user['id']}}, token
        if method != 'POST':
            raise households.HouseholdError(405, 'Ugyldig metode.')
        local = body.get('data')
        base = body.get('base')
        validate(local)
        validate(base)
        revision = body.get('revision')
        if type(revision) is not int or revision < 0:
            raise households.HouseholdError(400, 'Ugyldig versjon.')
        db.execute('BEGIN IMMEDIATE')
        current = _view(db, owner)
        if revision == current['revision']:
            updated = local
        else:
            updated = merge(base, local, current['data'])
        packed = validate(updated)
        db.execute('INSERT INTO core_documents(owner, data, revision) VALUES(?,?,1) '
                   'ON CONFLICT(owner) DO UPDATE SET data=excluded.data, revision=core_documents.revision+1',
                   (owner, packed))
        return {**_view(db, owner), 'scope': scope}, token
