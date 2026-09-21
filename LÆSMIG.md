# Twitch Plays — chatten styrer spillet

Lader din Twitch-chat sende tastetryk og museklik ind i et spil, som DougDoug gør det.
Ingen installation, ingen pip-pakker, ingen API-nøgler, intet login. Kun Python på Windows.

---

## Første gang: installér Python

Programmet har brug for **Python** — det er gratis, og det er det eneste der skal
installeres. Du skal ikke bruge det til noget selv; det kører bare i baggrunden.

1. Gå til **[python.org/downloads](https://www.python.org/downloads/)**
2. Klik på den store gule knap **Download Python**
3. Åbn filen der bliver hentet
4. **Vigtigt:** sæt flueben i **"Add python.exe to PATH"** nederst i vinduet,
   *før* du klikker videre
5. Klik **Install Now** og vent til den er færdig

Glemmer du fluebenet, finder programmet som regel Python alligevel — men sæt det nu.

Starter du `START.bat` uden at have Python, får du selv samme vejledning på skærmen,
og python.org åbner automatisk.

---

## Kom i gang

**Dobbeltklik på `START.bat`.** Så åbner kontrolpanelet, og resten klarer du med musen.

1. Skriv dit Twitch-kanalnavn i feltet under **Kom i gang**
2. Start spillet, og vælg det under **Indstillinger → Kun dette spil**
3. Tryk **Start** oppe i hjørnet
4. Klik ind i spillet, så det er det aktive vindue — nu styrer chatten

> **F8 er nødbremsen.** Virker hvor som helst, også midt i spillet. Alt sættes på pause
> og alle taster slippes. Tryk F8 igen for at fortsætte.

Luk det sorte konsolvindue for at slukke helt.

---

## Kontrolpanelet

**Kom i gang** — kanalnavn, kort vejledning og adressen til OBS-overlayet.

**Kommandoer** — hele listen over hvad chatten kan skrive.
- Klik på tastefeltet og **tryk tasten** — den optager den selv
- Tryk på ▶ for at afprøve en kommando i det spil du har åbent
- **Forklaringen** under hver linje er det seerne læser på overlayet
- Sætter du længden til **1 sekund eller mere**, må chatten selv bestemme:
  så virker `frem 2` som "hold frem nede i 2 sekunder"

**Indstillinger** —
- *Anarki*: hver besked bliver til et tastetryk med det samme. Sjovest med mange seere.
- *Afstemning*: chatten stemmer, og flertallet vinder. Passer til rolige spil og Pokémon.
- *Kun dette spil*: vælg spillets vindue, så chatten ikke kommer til at skrive i Discord
  eller browseren. Stærkt anbefalet.
- *Pause mellem hver seers kommandoer*: forhindrer at én person spammer.

**Live** — hvem der sender hvad, mens det sker.

**Profil** (nederst til venstre) — skift mellem færdige opsætninger til forskellige spil.
Hver profil husker sine egne kommandoer og indstillinger. Alt gemmes automatisk i den
profil du har valgt.

---

## Overlay til OBS

Et skilt på streamen der fortæller **seerne** hvad de kan skrive. Det viser
kommandolisten med forklaringer og bladrer selv videre, hvis der er mange.
Det opdaterer sig selv, når du ændrer noget i kontrolpanelet.

I OBS: **Kilder → + → Browser** → URL `http://localhost:8777`,
bredde `380`, højde `480`. Baggrunden er gennemsigtig.

Sætter du programmet på pause med F8, står der "SAT PÅ PAUSE" på overlayet,
så seerne kan se hvorfor der ikke sker noget.

---

## Færdige profiler

- **config** — almindeligt WASD-spil, anarki
- **minecraft** — grav, byg og kig-kommandoer
- **pokemon-emulator** — klassisk Twitch Plays Pokémon med afstemning

Husk at rette kanalnavnet, når du skifter til en ny profil.

---

## Hvis det ikke virker

**Intet sker i spillet**
Luk programmet, højreklik på `START.bat` og vælg *Kør som administrator*. Nogle spil
kører med administratorrettigheder, og Windows blokerer tastetryk fra almindelige
programmer.

**Virker i menuen, men ikke i selve spillet**
Sæt spillet til *borderless window* eller *windowed* i stedet for eksklusiv fuldskærm.

**Chatten reagerer 3–5 sekunder forsinket**
Det er stream-forsinkelsen — seerne ser billedet senere end det sker. Slå
*lav latenstid* til i Twitch-indstillingerne for at mindske det.

**Der sker slet ingenting**
Tjek at kanalnavnet er stavet rigtigt, og at der står *Forbundet* øverst i panelet.

**Kontrolpanelet åbner ikke**
Åbn selv `http://localhost:8776` i en browser.

**"Python mangler" — men jeg har installeret det**
Genstart computeren og prøv igen. Windows opdager først den nye installation,
når den har fået lov at genstarte. Hjælper det ikke, så kør installationsfilen fra
python.org igen, vælg *Modify* og sæt flueben i *Add python.exe to PATH*.

**Vigtigt:** brug det ikke i konkurrencespil med anti-cheat (Valorant, Fortnite, CS2,
Rainbow Six). Automatiseret input kan give udelukkelse. Singleplayer, emulatorer,
Minecraft og fjollede spil er det rigtige sted.

---

## For den nysgerrige

| Fil | Hvad den gør |
|---|---|
| `START.bat` | Åbner kontrolpanelet |
| `kontrolpanel.py` | Brugerfladen og styringen |
| `twitchplays.py` | Motoren: chatforbindelse og tastetryk |
| `ui.html` | Selve kontrolpanelets udseende |
| `overlay.html` | Skiltet seerne ser på streamen |
| `config.json` | Din opsætning (kontrolpanelet skriver i den) |
| `profiler/` | Færdige opsætninger til forskellige spil |

`START-uden-brugerflade.bat` kører motoren direkte fra `config.json` uden panelet.

Programmet forbinder til Twitch som anonym læser — det kan ikke skrive i chatten,
og der er ingen adgangskode eller token involveret. Alt kører lokalt på maskinen.

### Tilgængelige taster

```
a-z            0-9
space enter tab backspace esc delete insert
shift ctrl alt   rshift rctrl ralt
up down left right   home end pageup pagedown
f1-f12         num0-num9
- = [ ] ; ' ` \ , . /
```
