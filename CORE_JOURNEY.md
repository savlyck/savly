# SAVLY core journey — 31. oktober 2026

Denne filen erstatter den opprinnelige arbeidsplanen. Se [README.md](README.md) for oppstart, konfigurering, sikkerhetskopiering og deploy.

## Versjon og status
- Utgangspunkt: commit `e764538ec570ec651d4e592710c9f478a4157ed4` på main.
- Endret utviklingsgren: `feature/core-journey-2026-10-31`.
- Ny startside er `/`, og gammel brukerflate bevares på `/legacy`.
- Bare kode på GitHub. Ikke verifisert oppdatert Render-produksjon, ikke bekreftet App Store/Google Play.

## Implementert
- Kort gjesteoppsett, mørkeblå/hvit visuell profil og fire hovedfaner.
- Middager på ukedager, egne ingredienser, startoppskrifter, favoritter, kopiering, flytting, porsjoner og forrige ukes plan.
- Automatisk handleliste fra valgte middager, kompatible enheter og proveniens, idempotent generering, manuelle varer, avkryssing, redigering og angre sletting.
- Valgfritt kjøleskap/har hjemme og forslag basert på kjente varenavn. Uten automatisk lagerreduksjon.
- Kassalapp via `price_gateway.py` og konfigurasjon, nøytrale produktbilder i ny brukerflate.
- SQLite-baserte serverøkter og persisterte dokumenter for Google-kontoer, med autorisert husholdningsscope og revisjonskontroll.
- Ikke-destruktiv overgang fra deler av gammel lokal lagring og gamle delte husstandsdata, med eksport/import.

## Automatisert verifikasjon
- Python-testene dekker session-cookies, persistering, CSRF, husholdningsautorisasjon, konfliktavvisning og gammel husstandsdata.
- Node-testene dekker ikoner, uforenlige mengder, porsjoner, idempotens, redigering og gjesteimport.
- GitHub Actions tester med Chromium: onboarding, handleliste, varer hjemme, oppdatering etter reload, to middager og API-feil.
- Se **Actions** for resultat knyttet til aktuell commit. Oppgi alltid om siste commit har grønn CI.

## Kritiske manuelle tester før produksjon
- Google OAuth på fysisk iPhone Safari og Chrome Android med riktig offentlig origin.
- Samme konto: iPhone ↔ PC og omstart/deploy med varig database.
- To konti i delt husstand som gjør motstridende og uavhengige endringer.
- Import av eksisterende reelle data fra produksjon, med backup før og etter.
- Render persistent disk og ny/eldre databaseplassering.
- Kjente allergier, prisdatoer og begrensninger, korrekt kontrakt med bildekilde.
- Ingen ekte Pro-betaling eller abonnementsverifisering finnes.

## Uferdig
- Ekte OAuth kan ikke endelig bekreftes uten domenekonfigurasjon og fysisk enhet.
- Store oppskriftskataloger og kvitteringsskann er ikke gjeninnført i den nye hovedflyten. Den eldre siden ligger på /legacy.
- Prisadapter kan utvides, men bare Kassalapp er implementert.
- Telefonpublisering krever separat PWA-/wrapper-beslutning, native testing og juridiske krav.
- Eldre data kan ha avvik som krever kontrollert migreringsjobb.

## Akseptansekriterier for utrulling
1. CI grønn på eksakt commit.
2. Kopi av produksjonsdatabasen verifisert.
3. Permanent datadisk konfigurert, med riktig path og rettigheter.
4. Google innloggingsrunde testet på iPhone Safari, inkludert ny åpning av appen.
5. Demo/Pro i gammel app behandles som eldre funksjonalitet; ny app viser ikke betaling.
6. Først deretter manuell gjennomgang og publisering.
