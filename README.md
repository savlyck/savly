# SAVLY

SAVLY er en norsk webapp for å planlegge middager, lage handleliste og bruke varer man har hjemme.

**Ny hovedapp:** `/` eller `/app` | **Tidligere app:** `/legacy`

Prosjektet bruker eksisterende Python-backend, SQLite og Kassalapp. Ingen ny betalt leverandør er innført.

## Lokal oppstart

Python 3.10+.

```bash
python -m pip install -r requirements.txt
python server.py
```

Åpne **http://localhost:8787**. Gjestebruk fungerer uten innlogging eller API-nøkkel.

For å aktivere tjenester:

```bash
export GOOGLE_CLIENT_ID="GOOGLE_OAUTH_WEB_CLIENT_ID"
export KASSALAPP_API_KEY="API_KEY"
export SAVLY_PRICE_PROVIDER="kassalapp"
export SAVLY_DB="./savly.sqlite3"
export PORT=8787
python server.py
```

På Windows PowerShell settes variabler med `$env:GOOGLE_CLIENT_ID="..."`.

## Render: viktig om data

**Ikke oppgrader produksjon uten å sikre eksisterende database først.**
Render sitt standardfilsystem er midlertidig. Ved deploy kan databasen forsvinne dersom den ikke ligger på en varig disk. SAVLY krever for serverlagrede kontoer og delte husholdninger:

- Persistent disk med databasekopi fra tidligere installasjon
- `SAVLY_DB=/var/data/savly.sqlite3` (tilpass faktisk monteringspunkt)
- `SAVLY_PUBLIC_ORIGIN=https://<ditt-domene>`
- `GOOGLE_CLIENT_ID` for samme autoriserte nettside
- `KASSALAPP_API_KEY` dersom prissøk skal fungere

Ikke slå på persistent disk eller betalte tjenester uten å undersøke kostnad og bekrefte plassering av den gamle databasen. For flere serverinstanser anbefales en felles transaksjonsdatabase, ikke separate SQLite-disker. SQLite med én varig skribent er et bevisst mellomsteg.

## Kjerneflyt

1. Åpne appen uten konto.
2. Velg antall personer og eventuelt matvarer å unngå.
3. Velg en middag eller lag en egen.
4. Få automatisk handleliste fra valgte middager, rediger, merk «Har hjemme».
5. Kom tilbake neste uke og gjenbruk middagsplanen.

Brukere kan logge på med Google fra profilen for serverlagring. Gjesteinnhold sendes til kontoen med stabile ID-er; slettes lokalt først når opplasting er bekreftet. Originale eldre datanøkler blir ikke slettet. Den gamle webappen er fortsatt tilgjengelig på `/legacy`.

Gjester og kontobrukere kan eksportere og importere en JSON-kopi.

## Server-API

- `GET /api/session`: økt og Google nonce/CSRF
- `POST /api/auth/google`: verifisert Google-ID-token
- `GET /api/core?scope=personal|household`: personlig eller delt dokument
- `POST /api/core?scope=personal|household`: endring med base og revisjon, 3-veis konfliktkontroll
- `GET /api/products?q=melk`: relevante produkter via konfigurert prisleverandør
- `GET /api/compare?ean=...`: samme strekkode hos ulike kjeder

Kassalapp er eneste implementerte prisadapter. `SAVLY_PRICE_PROVIDER=off` deaktiverer søk, og det påvirker ikke handleliste eller ukeplan. API-nøkkel sendes aldri til nettleseren.

## Tester

GitHub Actions kjører Python, Node og ekte Chromium-test på utviklingsgrenen. Lokalt:

```bash
python -m unittest discover -s tests -p 'test_*.py' -v
node --test tests/model.test.cjs
node --check public/app.js
```

Chromium-testene bruker Playwright og krever oppstartet `python server.py` på port 8787.

## Ikke verifisert eller uferdig

- Safari på fysisk iPhone, Android Chrome på fysisk telefon og Google-login med ekte konto er ikke en del av CI.
- Synkronisering og konflikthåndtering har backend-tester, men ikke fullstendig to-enhets nettlesertest.
- Enkel oppskriftssamling er SAVLYs egne eksempler, ikke en komplett lisensiert oppskriftsdatabase.
- Ingen allergisikkerhetsgaranti. Verifiser emballasje og ingredienser.
- Produktbilder vises nøytralt i ny app inntil distribusjonsrettigheter er avklart.
- Bruk av gammel lokal lagring importeres etter beste evne; eldre lagringsformater kan kreve manuell import.
- Ingen virkelig betalingsflyt eller Pro-abonnement.
- App Store og Google Play krever eget arbeid med app-pakking, personvern, kontosletting, utviklerkontoer og fysisk enhetstesting.
- Render-produksjon er ikke verifisert. Se CI og GitHub-PR for faktisk status.
