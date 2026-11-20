# Newsletter

[![Tests](https://github.com/Kynto-intel/vendo-newsletter/actions/workflows/tests.yml/badge.svg)](https://github.com/Kynto-intel/vendo-newsletter/actions/workflows/tests.yml)

Newsletter-Kampagnen und Automationen für kleine Online-Shops über das **eigene Postfach**: Versand per SMTP, Kontakte
aus Shopify, keine Abo-Kosten pro Empfänger. Plugin für [Vendo](https://github.com/Kynto-intel/vendo), die
Windows-Oberfläche für Hermes Agent.

- **Versand:** eigenes Postfach per SMTP (voreingestellt IONOS, `smtp.ionos.de:465`), Testmail, Versandprotokoll,
  Drossel mit Stundenbudget (Voreinstellung 300, höchstens 500 je Stunde) und Pause bei Limit-Fehlern des Servers,
  Warteschlange mit Wiederholungen und Verfallsfrist.
- **Kontakte:** Abonnenten aus Shopify mit Marketing-Zustimmung, dazu CSV-Import. Abmeldungen werden in beide
  Richtungen abgeglichen; Abmeldungen per Mail liest das Plugin über IMAP aus einem Postfach-Ordner.
- **Kampagnen und Vorlagen:** Mail-HTML mit mitlaufender Vorschau, mitgelieferte Muster unter `vorlagen/`, Kopf und
  Fuß mit Logo, Impressum und Abmeldelink, UTM-Parameter an Shop-Links. Links und Bilder werden vor der Freigabe gegen
  den eigenen Shop geprüft.
- **Automationen:** Warenkorbabbruch, Willkommen und Rückgewinnung als Schrittfolgen mit Wartezeiten; Versand nur an
  Kontakte mit Zustimmung, geprüft beim Start und kurz vor jeder Mail.
- **Zustellung:** Rückläufer und Beschwerden aus einem eigenen Postfach-Ordner, Sperren, Ampel je Kampagne und
  automatisches Anhalten bei Rot.
- **Ergebnisse:** Bestellungen werden über UTM-Parameter den Mails zugeordnet. Öffnungs- und Klickraten misst das
  Plugin **nicht** (dafür bräuchte es einen aus dem Internet erreichbaren Endpunkt).
- **KI-Unterstützung (über Vendo und Hermes):** Entwürfe über Vendos KI-Anbindung; ein Hermes-Bot kann über einen
  Auftragsordner Kampagnen, Vorlagen und ausgeschaltete Automationen vorbereiten. **Versenden, planen und Automationen
  einschalten kann nur ein Mensch in Vendo.**

## Voraussetzungen

- [Vendo](https://github.com/Kynto-intel/vendo) unter Windows. Das Plugin läuft im Hauptprozess von Vendo und
  verschlüsselt Passwörter mit Electrons `safeStorage` (Windows-DPAPI). Einen eigenständigen Betrieb ohne Vendo gibt es
  noch nicht.
- Node.js 20 oder neuer und npm (für `npm install`).
- Ein Postfach mit SMTP-Zugang. Für Abmeldungen und Rückläufer zusätzlich IMAP und je ein Ordner mit Filterregel.
- Optional: Shopify-Shop mit Admin-API-Zugriffstoken (`read_customers`, `write_customers` für zurückgeschriebene
  Abmeldungen, `read_orders` für Warenkörbe und Ergebnisse, dazu die Freigabe für geschützte Kundendaten). In Vendo kommt der Token aus den
  Hermes-Einstellungen (`SHOPIFY_ACCESS_TOKEN`, `SHOPIFY_STORE`; das Hermes-Profil gibt Vendo über `VENDO_HERMES_PROFIL` vor).

## In Vendo einbinden

Das Repository neben Vendo klonen und als Verknüpfung in Vendos Plugin-Ordner einhängen:

```powershell
git clone https://github.com/Kynto-intel/vendo-newsletter.git
cd vendo-newsletter
npm install
New-Item -ItemType Junction -Path ..\Vendo\plugins\newsletter -Target (Get-Location)
```

Danach Vendo neu starten; der Bereich „Newsletter“ erscheint in der Seitenleiste. Daten (Kontakte, Kampagnen,
Warteschlange) speichert Vendo über die Plugin-API; Versandprotokoll, Bot-Aufträge und Entwurfsdateien liegen unter
Vendos `daten/plugins/newsletter/`. Nichts davon gehört in dieses Repository.

Für größere Bestände ist ein zweiter Speicher eingebaut: eigene Tabellen im Schema `newsletter` in Vendos PostgreSQL
(`db.js`, `speicher-tabellen.js`), mit dem Versandprotokoll als Tabelle und ohne die Größengrenze der Plugin-Daten. Er
wird erst genutzt, wenn die Plugin-Daten die Markierung `_speicher: { modus: 'tabellen' }` tragen. Ein Werkzeug, das die
vorhandenen Daten in die Tabellen übernimmt und diese Markierung setzt, gibt es noch nicht.

Die Muster unter `vorlagen/` sind neutrale Beispiele. Eigene Muster im Stil der eigenen Marke gehören in den Ordner
`vorlagen-eigene/` daneben (von Git ausgeschlossen): Eine Datei dort ersetzt das gleichnamige Beispiel oder kommt als
weiteres Muster dazu.

## Grenzen

- Shopify-Abgleich höchstens 10.000 Kontakte (40 Seiten zu 250).
- Kein „genau einmal“: Bricht Vendo genau zwischen Annahme durch den Mailserver und dem Speichern ab, steht die Mail
  danach auf `unklar` und wird nicht von selbst wiederholt. Lieber eine Mail zu wenig als eine doppelt.
- Das Stundenlimit hängt am Postfach, nicht am Programm. Wer über dasselbe Postfach auch Kundenservice macht, sollte
  im Budget Luft lassen.
- Die Plugin-Daten dürfen in Vendo höchstens etwa 5 MB groß werden.
- Versand läuft nur, solange Vendo läuft.
- Vor dem ersten echten Versand SPF, DKIM und DMARC der Absenderdomain prüfen.

> Keine Rechtsberatung. Abmeldelink und Impressum baut das Plugin in jede Kampagnenmail ein; ob Einwilligungen und
> Inhalte den Regeln entsprechen, bleibt Sache des Versenders.

## Entwickeln und testen

```powershell
npm install
npm test
```

Die Tests laufen ohne Electron, ohne Netz und ohne echten Versand; SMTP, IMAP und Shopify sind durch Stubs ersetzt,
alle Testdaten sind erfunden. Mehr in [CONTRIBUTING.md](CONTRIBUTING.md), Regeln für Coding-Agenten in
[AGENTS.md](AGENTS.md).

## Lizenz

AGPL-3.0-or-later, siehe [LIZENZ.md](LIZENZ.md) und [LICENSE](LICENSE).
