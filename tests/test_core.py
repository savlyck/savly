import copy
import http.cookiejar
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

import households
import core_store
import server


class CoreStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        households.DB_PATH = os.path.join(self.temp.name, 'savly.sqlite3')
        households.INITIALIZED = False
        households.init_db()
        self.token, sess = households.session('')
        self.csrf = sess['csrf']
        self.user = {'id': 'g_testuser', 'name': 'Tester', 'provider': 'google'}
        self.token, sess = households.rotate(self.token, self.user)
        self.csrf = sess['csrf']
        self.cookie = 'other=%7Bhello%7D; savly_session=' + self.token
        with households.connection() as db:
            db.execute('INSERT INTO users(id,name,provider) VALUES(?,?,?)',
                       (self.user['id'], self.user['name'], 'google'))

    def tearDown(self):
        self.temp.cleanup()

    def test_sessions_survive_memory_reset(self):
        households.SESSIONS.clear()
        new, sess = households.session(self.cookie)
        self.assertEqual(new, self.token)
        self.assertEqual(sess['user']['id'], self.user['id'])
        self.assertTrue(households.session_cookie(self.cookie))
        self.assertFalse(households.session_cookie('savly_session=bad; savly_session=' + self.token))

    def test_core_read_write_and_restart(self):
        doc = core_store.DEFAULT.copy()
        doc = copy.deepcopy(doc)
        doc['meals'].append({'id': 'meal1', 'title': 'Taco', 'date': '2026-10-31', 'type': 'dinner',
                             'ingredients': [{'name': 'Kjøttdeig', 'quantity': 400, 'unit': 'g'}]})
        result, token = core_store.handle('POST', {'data': doc, 'base': copy.deepcopy(core_store.DEFAULT),
                                                    'revision': 0}, self.cookie, self.csrf)
        self.assertEqual(result['revision'], 1)
        self.assertEqual(token, self.token)
        households.SESSIONS.clear()
        saved, _ = core_store.handle('GET', {}, self.cookie, None)
        self.assertEqual(saved['data']['meals'][0]['title'], 'Taco')

    def test_csrf_is_required(self):
        with self.assertRaises(households.HouseholdError) as context:
            core_store.handle('POST', {'data': core_store.DEFAULT, 'base': core_store.DEFAULT, 'revision': 0},
                              self.cookie, 'wrong')
        self.assertEqual(context.exception.status, 403)

    def test_independent_changes_merge_and_conflicts_reject(self):
        base = copy.deepcopy(core_store.DEFAULT)
        base['list'] = [
            {'id': 'rice', 'name': 'Ris', 'done': False},
            {'id': 'milk', 'name': 'Melk', 'done': False}]
        remote = copy.deepcopy(base)
        local = copy.deepcopy(base)
        remote['list'][0]['done'] = True
        local['list'][1]['done'] = True
        result = core_store.merge(base, local, remote)
        self.assertTrue(all(x['done'] for x in result['list']))
        conflicting = copy.deepcopy(base)
        conflicting['list'][0]['name'] = 'Basmati'
        remote['list'][0]['name'] = 'Jasmin'
        with self.assertRaises(households.HouseholdError) as error:
            core_store.merge(base, conflicting, remote)
        self.assertEqual(error.exception.status, 409)

    def test_unauthorized_household_access(self):
        with self.assertRaises(households.HouseholdError) as context:
            core_store.handle('GET', {}, self.cookie, None, 'household')
        self.assertEqual(context.exception.status, 403)

    def test_household_member_can_share_but_stranger_cannot(self):
        with households.connection() as db:
            db.execute('INSERT INTO homes(id,name,size,owner,code,expires,data) VALUES(?,?,?,?,?,?,?)',
                       ('shared1','Vårt hjem',2,self.user['id'],'AC12345678',9999999999,json.dumps(households.EMPTY)))
            db.execute('INSERT INTO members VALUES(?,?,?)',(self.user['id'],'shared1',1))
        result,_=core_store.handle('GET',{},self.cookie,None,'household')
        self.assertEqual(result['scope'],'household')
        other_token, other = households.session('')
        other_token, other = households.rotate(other_token,
                          {'id':'g_stranger','provider':'google','name':'Ukjent'})
        with self.assertRaises(households.HouseholdError) as error:
            core_store.handle('GET',{},'savly_session='+other_token,None,'household')
        self.assertEqual(error.exception.status,403)

    def test_invalid_preferences_are_rejected(self):
        data = copy.deepcopy(core_store.DEFAULT)
        data['prefs']['people'] = 'many'
        with self.assertRaises(households.HouseholdError) as context:
            core_store.validate(data)
        self.assertEqual(context.exception.status, 400)


class HTTPTests(unittest.TestCase):
    def test_guest_app_and_security(self):
        from http.server import ThreadingHTTPServer
        host = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        runner = threading.Thread(target=host.serve_forever, daemon=True)
        runner.start()
        try:
            base = 'http://127.0.0.1:' + str(host.server_port)
            opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
            for path in ('/app', '/app.js', '/model.js', '/app.css'):
                with opener.open(base + path, timeout=5) as response:
                    self.assertEqual(response.status, 200)
                    self.assertGreater(len(response.read()), 100)
            with opener.open(base + '/api/session', timeout=5) as response:
                data = json.load(response)
                self.assertTrue(data['csrf'])
                self.assertIsNone(data['user'])
            with self.assertRaises(urllib.error.HTTPError) as error:
                opener.open(base + '/api/core',timeout=5)
            self.assertEqual(error.exception.code,401)
        finally:
            host.shutdown()
            host.server_close()


if __name__ == '__main__':
    unittest.main()
