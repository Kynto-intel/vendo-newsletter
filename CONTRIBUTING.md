# Mitwirken

Schön, dass du mitmachen willst. Programmieren ist keine Voraussetzung: Fehlermeldungen, Ideen und Hinweise auf
Zustellprobleme helfen genauso.

> **Keine echten Daten.** Niemals echte Kontakte, Mailadressen, Bestellungen, Tokens oder Zugangsdaten in Issues,
> Pull Requests, Tests oder Bildschirmfotos. Immer erfundene Werte verwenden (`beispiel.de`, `.invalid`).

## Fehler und Ideen melden

Ein Issue mit diesen Punkten:

- **Anlass:** Was ist passiert oder was fehlt?
- **Stand:** Mit welcher Version, welcher Vendo-Version und welchem Mailanbieter?
- **Vorschlag:** Was sollte stattdessen passieren?

Sicherheitslücken bitte **nicht** als öffentliches Issue melden, sondern über *Security → Report a vulnerability* in
diesem Repository.

## Etwas übernehmen

1. Zu einem Issue kommentieren, dass du es übernimmst – oder erst ein Issue anlegen, wenn es noch keins gibt.
2. Eigenen Branch anlegen (im Fork), nie direkt auf `main`.
3. Ein Thema pro Pull Request.

## Entwickeln

Voraussetzung: Node.js 20 oder neuer (getestet mit 24), Git. Für die Oberfläche zusätzlich Vendo, siehe README.

```
npm install
npm test
```

Regeln für den Code:

- Electron nur in `tresor.js`; der übrige Code läuft auch in einem normalen Node-Prozess.
- Vendos Datenordner aus `ctx.ordner` ableiten, nie aus `__dirname` (das Plugin ist in Vendo eine Verknüpfung).
- Plugin-Daten nur über `speicher.js`; vor SMTP-Versand oder dem Markieren von Mails `await speicher.festschreiben()`.
- Geheimnisse nur verschlüsselt speichern, nie an die Oberfläche zurückgeben.
- Versenden, Planen und Einschalten von Automationen bleibt einem Menschen vorbehalten.
- Keine neuen Abhängigkeiten ohne Begründung im Pull Request.
- Oberfläche und Meldungen auf Deutsch; nutzergesteuerte Texte immer mit `ctx.maskieren` einsetzen.

## Tests

- Tests mit `node:test` in `tests/`, Testdaten in `tests/fixtures/` – nur erfundene Werte.
- Neue Funktion: Verhaltenstest dazu. Fehlerbehebung: zuerst ein Test, der den Fehler zeigt.
- SMTP, IMAP und Shopify im Test durch Stubs ersetzen; kein Netz, nie ein echter Versand. Electron ersetzt
  `tests/hilfen/electron-ersatz.cjs`.
- Vor dem Push: `npm test` lokal grün. GitHub Actions führt die Tests bei jedem Pull Request erneut aus.
- Was du nicht prüfen konntest (z. B. einen anderen Mailanbieter), schreibst du in die Beschreibung.

## Commits und Pull Requests

- Titel des Pull Requests: `Bereich: was sich ändert (#Issue)`, z. B. `Drossel: Budget je Postfach (#12)`.
- Commits gern als Conventional Commits auf Deutsch, z. B. `fix(imap): Abmeldung mit Betreff in Großbuchstaben erkennen`.
- **Commit-E-Mail:** Bitte die GitHub-noreply-Adresse verwenden (`git config user.email "…@users.noreply.github.com"`),
  sonst lehnt GitHub den Push bei aktiviertem E-Mail-Schutz ab und deine private Adresse wäre öffentlich.
- Mit dem Beitrag stimmst du zu, dass er unter der Lizenz des Projekts steht (AGPL-3.0-or-later).

## Mit KI-Werkzeugen

KI-Werkzeuge sind ausdrücklich erlaubt; dieses Projekt entsteht selbst größtenteils so. Dabei gilt:

- Agenten bekommen [`AGENTS.md`](AGENTS.md) als Einstieg (Claude Code liest es über `CLAUDE.md`).
- Kennzeichne KI-Mitarbeit mit einer `Co-Authored-By:`-Zeile im Commit und einem Satz in der Beschreibung des Pull
  Requests (welches Werkzeug, wobei).
- Verantwortlich bist du: Lies, was der Agent geändert hat, und prüfe die Oberfläche selbst.
- Gib einem Agenten nie echte Kontaktlisten oder Zugangsdaten.

## Wie Beiträge angenommen werden

Der Maintainer prüft jeden Pull Request mit vier Fragen:

1. **Passt es?** Gehört es zu einem Newsletter für kleine Shops über das eigene Postfach?
2. **Ist es sicher?** Keine doppelten Mails, kein Versand ohne Zustimmung oder Freigabe.
3. **Ist es einfach genug?** Die kleinste Änderung, die das Problem löst.
4. **Hält es die Regeln ein?** Tests grün, keine echten Daten, Regeln oben.

Änderungen an Versand, Warteschlange, Drossel, Zustimmungsprüfung oder Verschlüsselung brauchen immer das
ausdrückliche Okay des Maintainers.
