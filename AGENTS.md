# AGENTS.md

Regeln für Coding-Agenten in diesem Repository. Zuerst lesen: `README.md`, `CONTRIBUTING.md`, dann die betroffenen
Dateien, ihre Aufrufstellen und Tests. Liegt eine lokale `STAND.md` daneben, steht dort der Bauplan.

## Aufbau

- Vendo-Plugin: `plugin.json`, `ansicht.js` (Oberfläche, ES-Modul ohne Build-Schritt), `stil.css`, `haupt.js`
  (Hintergrundteil, CommonJS). `haupt.js` verdrahtet nur; die Arbeit machen die Module daneben (eine Datei je Aufgabe).
- Der Versandteil (`mail.js`, `smtp.js`, `drossel.js`, `warteschlange.js`) weiß nichts über Kampagnen, Shopify oder
  Hermes, nur „diese Mail, dieser Empfänger“.
- **Kein Electron-Aufruf außerhalb von `tresor.js`.** Der Kern soll später ohne Electron laufen können.
- In Vendo ist das Repository per Verknüpfung als `plugins/newsletter` eingebunden. `__dirname` zeigt dann auf dieses
  Repository; Vendos `daten/` kommt deshalb aus `ctx.ordner`, nie aus `__dirname`.
- Plugin-Daten nur über `speicher.js` (`lesen`, `speichern`, `feldSpeichern`, `festschreiben`); kein anderes Modul
  und nicht die Oberfläche fasst `ctx.datenLaden`, `ctx.datenSpeichern` oder `ctx.daten` an (ein Test prüft das).
  Vor jedem Schritt nach außen, der sich nicht zurücknehmen lässt (SMTP, Mails als gelesen markieren), `await
  speicher.festschreiben()`. Zeitgeber genau einmal starten (Schutz im Modul-Scope):
  Vendo ruft die Aufbaufunktion bei jedem Laden der Plugin-Liste erneut auf.

## Unverrückbar

- Ein Fehler im Versandcode schickt echte Mails an echte Kunden. Tests ersetzen SMTP, IMAP und Shopify durch Stubs;
  **nie** ein echter Versand oder Netzzugriff im Test.
- Senden, Planen und Einschalten einer Automation bleiben einem Menschen vorbehalten. Bots bekommen dafür keine Aktion.
- Kampagnenmails nur mit Abmeldelink und Impressum; nur an Kontakte mit Zustimmung.
- Geheimnisse (Postfach-Passwort, Tokens) nur verschlüsselt über `tresor.js`; nie an die Oberfläche, in Logs, Tests
  oder Commits. Ohne verfügbare Verschlüsselung wird nichts gespeichert.
- Nie echte Kontakte, Adressen, Bestellungen oder Zugangsdaten in Code, Tests, Fixtures, Issues oder Commits.
- Keine Logos, Markennamen, Shop-Adressen oder Personennamen des Betreibers im Repository. Muster unter `vorlagen/`
  bleiben neutral (`beispiel-shop.de`); eigene Muster liegen lokal in `vorlagen-eigene/`. Kein fest eingetragener
  Hermes-Profilname: den gibt Vendo über `VENDO_HERMES_PROFIL` vor.
- Hermes-Programmcode wird nicht verändert.
- Keine neuen Abhängigkeiten ohne Begründung; keinen fremden Code übernehmen, ohne Herkunft und Lizenz zu vermerken.
- Kein Commit, Push oder Merge auf `main` ohne Freigabe eines Menschen.

## Arbeiten

1. Prüfbare Annahme formulieren, nur den zuständigen Bereich ändern.
2. Neue Funktion mit Verhaltenstest; Fehlerbehebung zuerst mit fehlschlagendem Test. Nur erfundene Testdaten
   (`tests/fixtures/`, Adressen unter `beispiel.de` oder `.invalid`).
3. `npm test` ausführen. Oberfläche zusätzlich in Vendo prüfen.
4. `git diff --check`; prüfen, dass keine privaten Dateien oder echten Daten in der Änderung sind.
5. Ehrlich berichten: was geändert, was geprüft, was **nicht** geprüft wurde. Übersprungen ist nicht bestanden.
6. KI-Mitarbeit im Commit mit `Co-Authored-By:` kennzeichnen.

Oberfläche, Meldungen und Doku auf Deutsch.
