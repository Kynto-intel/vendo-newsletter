'use strict'
// Newsletter-Plugin: der einzige Zugang zu den gespeicherten Daten.
//
// Alles Lesen und Schreiben läuft hier durch (Schritt N1 des PostgreSQL-Umbaus). Dahinter liegt einer von zwei
// Speichern mit derselben Schnittstelle:
//
//   - Standard: Vendos gemeinsamer Plugin-Speicher (`ctx.datenLaden`/`ctx.datenSpeichern`, in Vendo ein jsonb-Feld in
//     PostgreSQL); das Versandprotokoll liegt dann als Monatsdateien unter Vendos `daten/plugins/newsletter/`.
//   - Eigene Tabellen im Schema `newsletter` (Schritt N3, speicher-tabellen.js), mit dem Protokoll als Tabelle.
//     Gewählt, wenn die Plugin-Daten nur noch die Markierung `_speicher: { modus: 'tabellen' }` tragen; die setzt die
//     Übernahme der Daten in die Tabellen (Schritt N4). Bis dahin ändert sich am Betrieb nichts.
//
// `festschreiben` wartet, bis der Stand dauerhaft liegt: in der Datenbank oder, wenn sie nicht erreichbar ist, in
// einem Journal (Vendos `daten/speicher-offen/` beziehungsweise die Journaldatei des Tabellen-Speichers), das beim
// nächsten Start nachgeschrieben wird. Es gehört vor jeden Schritt nach außen, der sich nicht zurücknehmen lässt
// (SMTP-Versand, Mails im Postfach als gelesen markieren). Ohne `ctx.festschreiben` (Tests) tut es im Standard nichts.
//
// Der Tabellen-Speicher lädt beim Start asynchron. Bis dahin ist `istBereit()` falsch; haupt.js lässt Aufrufe dann
// auf `bereit` warten.

const fs = require('node:fs')
const path = require('node:path')
const { protokollSchreiben: dateiProtokollSchreiben, protokollLesen: dateiProtokollLesen } = require('./protokoll.js')
const { tabellenSpeicherMachen } = require('./speicher-tabellen.js')
const { SCHEMA } = require('./db.js')

const LISTEN = ['warteschlange', 'kontakte', 'kampagnen', 'vorlagen', 'automationen', 'laeufe', 'ruecklaeufer']
const BEREICHE = ['zugang', 'shopify', 'einstellungen', 'marke', 'drossel']
const MARKIERUNG = '_speicher'

// Gespeicherte Daten in die Form bringen, die der Rest erwartet: jede Liste ist eine Liste, jeder Bereich ein Objekt
function vervollstaendigen(roh) {
  const d = roh && typeof roh === 'object' ? roh : {}
  const aus = { ...d }
  delete aus[MARKIERUNG]
  for (const b of BEREICHE) aus[b] = d[b] || {}
  for (const l of LISTEN) aus[l] = Array.isArray(d[l]) ? d[l] : []
  return aus
}

// Welcher Speicher gilt: steht in den Plugin-Daten die Markierung der Übernahme, die Tabellen
const modusVon = (roh) => (roh && roh[MARKIERUNG]?.modus === 'tabellen' ? 'tabellen' : 'plugin')

// Standard: Vendos gemeinsamer Plugin-Speicher
function pluginSpeicherMachen(ctx, { protokollOrdner } = {}) {
  const lesen = () => vervollstaendigen(ctx.datenLaden())
  const speichern = (daten) => ctx.datenSpeichern(daten)
  const festschreiben = async () => {
    if (typeof ctx.festschreiben !== 'function') return
    try {
      await ctx.festschreiben()
    } catch {
      // Vendo hat den Stand dann ins Journal geschrieben und schreibt ihn nach; er ist also nicht verloren
    }
  }
  return {
    modus: 'plugin',
    bereit: Promise.resolve(),
    istBereit: () => true,
    lesen,
    speichern,
    festschreiben,
    protokollSchreiben: (eintrag) => dateiProtokollSchreiben(eintrag, protokollOrdner),
    protokollLesen: ({ anzahl = 50 } = {}) => dateiProtokollLesen({ anzahl, ordner: protokollOrdner }),
    zustand: () => ({ modus: 'plugin', geladen: true })
  }
}

// Eigene Tabellen. ctx.speicherSchema gibt es nur in Tests (eigenes Schema je Testlauf).
// Je Schema genau eine Instanz: Vendo ruft den Aufbau von haupt.js bei jedem Neuladen der Plugin-Liste erneut auf;
// zwei Zwischenspeicher derselben Tabellen würden sich gegenseitig überschreiben.
const tabellenInstanzen = new Map()
function tabellenSpeicherFuer(ctx, optionen = {}) {
  const schema = ctx.speicherSchema || SCHEMA
  if (!tabellenInstanzen.has(schema)) tabellenInstanzen.set(schema, tabellenSpeicherNeu(ctx, optionen))
  return tabellenInstanzen.get(schema)
}
// Was haupt.js vom Tabellen-Speicher sieht: vervollständigt gelesen, festschreiben ohne Ausnahme
function huelle(t) {
  return {
    ...t,
    lesen: () => vervollstaendigen(t.lesen()),
    festschreiben: async () => {
      try {
        await t.festschreiben()
      } catch {
        // Der Stand liegt dann im Journal; ein neuer Versuch läuft von selbst
      }
    }
  }
}

function tabellenSpeicherNeu(ctx, { journalDatei } = {}) {
  const t = tabellenSpeicherMachen({ datenbank: ctx.datenbank, schema: ctx.speicherSchema || SCHEMA, journalDatei })
  const starten = () => t.laden().catch((f) => {
    console.warn(`Newsletter: Daten aus der Datenbank nicht ladbar: ${f.message}. Neuer Versuch, sobald sie bereit ist.`)
    setTimeout(starten, 10_000).unref?.()
  })
  if (!ctx.datenbank) console.warn('Newsletter: Tabellen-Speicher gewählt, aber Vendo stellt keine Datenbank bereit.')
  else if (typeof ctx.datenbank.bereit === 'function' && !ctx.datenbank.bereit() && typeof ctx.datenbank.beiBereit === 'function') {
    let gestartet = false
    ctx.datenbank.beiBereit(() => { if (!gestartet) { gestartet = true; starten() } })
  } else starten()
  return huelle(t)
}

// JSON mit sortierten Schlüsseln: zwei Stände sind gleich, wenn ihr Inhalt gleich ist (jsonb ordnet Schlüssel um)
function kanonisch(x) {
  if (Array.isArray(x)) return `[${x.map(kanonisch).join(',')}]`
  if (x && typeof x === 'object') {
    const schluessel = Object.keys(x).filter((k) => x[k] !== undefined).sort()
    return `{${schluessel.map((k) => `${JSON.stringify(k)}:${kanonisch(x[k])}`).join(',')}}`
  }
  return JSON.stringify(x === undefined ? null : x)
}

// Zahlen für den Abgleich nach der Übernahme
function zaehlen(stand, protokoll) {
  const d = vervollstaendigen(stand)
  return {
    kontakte: d.kontakte.length,
    gesperrt: d.kontakte.filter((k) => k?.gesperrt).length,
    kampagnen: d.kampagnen.length,
    vorlagen: d.vorlagen.length,
    automationen: d.automationen.length,
    laeufe: d.laeufe.length,
    warteschlange: d.warteschlange.length,
    ruecklaeufer: d.ruecklaeufer.length,
    bestellungen: Array.isArray(d.ergebnisse?.bestellungen) ? d.ergebnisse.bestellungen.length : 0,
    protokoll: protokoll.length
  }
}

const PROTOKOLL_ALLE = 10_000_000

function speicherMachen(ctx, optionen = {}) {
  const roh = typeof ctx.datenLaden === 'function' ? ctx.datenLaden() : null
  let aktuell = modusVon(roh) === 'tabellen' ? tabellenSpeicherFuer(ctx, optionen) : pluginSpeicherMachen(ctx, optionen)
  // Während der Übernahme: nichts lesen oder schreiben (istBereit falsch, Aufrufe warten auf `bereit`)
  let uebernahme = null

  const w = {
    get modus() { return aktuell.modus },
    get bereit() { return uebernahme ? uebernahme.then(() => aktuell.bereit) : aktuell.bereit },
    istBereit: () => !uebernahme && aktuell.istBereit(),
    lesen: () => aktuell.lesen(),
    speichern: (daten) => {
      if (uebernahme) throw new Error('Die Übernahme in die Datenbank-Tabellen läuft gerade; nichts gespeichert.')
      aktuell.speichern(daten)
    },
    feldSpeichern: (feld, wert) => {
      const d = w.lesen()
      d[feld] = wert
      w.speichern(d)
    },
    festschreiben: () => aktuell.festschreiben(),
    protokollSchreiben: (eintrag) => aktuell.protokollSchreiben(eintrag),
    protokollLesen: (o) => aktuell.protokollLesen(o),
    zustand: () => ({ ...aktuell.zustand(), uebernahmeLaeuft: Boolean(uebernahme) })
  }

  // Schritt N4: die Daten aus dem Plugin-Speicher und die Protokolldateien in die eigenen Tabellen übernehmen.
  //   vorher(daten): Prüfung des Aufrufers (etwa keine laufende Kampagne); ein Text als Rückgabe bricht ab
  //   ruhe():        wartet, bis gerade laufende Arbeit (Takt) fertig ist
  // Ablauf: sperren, Sicherung als Datei, in leere Tabellen schreiben, frisch zurücklesen und vollständig vergleichen,
  // erst dann die Markierung setzen und umschalten. Bei jeder Abweichung oder jedem Fehler werden die Tabellen wieder
  // geleert, und es bleibt beim Plugin-Speicher.
  w.inTabellenUebernehmen = async ({ vorher = () => null, ruhe = async () => {}, jetzt = new Date() } = {}) => {
    if (aktuell.modus === 'tabellen') return { ok: false, text: 'Die Daten liegen schon in den Datenbank-Tabellen.' }
    if (uebernahme) return { ok: false, text: 'Die Übernahme läuft schon.' }
    if (!ctx.datenbank || (typeof ctx.datenbank.bereit === 'function' && !ctx.datenbank.bereit())) {
      return { ok: false, text: 'Die Datenbank ist nicht bereit. Läuft Docker?' }
    }
    const grund = vorher(aktuell.lesen())
    if (grund) return { ok: false, text: grund }

    let freigeben
    uebernahme = new Promise((r) => { freigeben = r })
    const schema = ctx.speicherSchema || SCHEMA
    let neu = null
    try {
      await ruhe()
      const stand = vervollstaendigen(ctx.datenLaden())
      const protokoll = dateiProtokollLesen({ anzahl: PROTOKOLL_ALLE, ordner: optionen.protokollOrdner }).reverse() // älteste zuerst

      // Sicherung neben den übrigen Newsletter-Daten (in Vendos daten/, nicht in Git)
      const ordner = optionen.sicherungOrdner || (optionen.journalDatei ? path.dirname(optionen.journalDatei) : null)
      if (!ordner) throw new Error('Kein Ordner für die Sicherung bekannt.')
      fs.mkdirSync(ordner, { recursive: true })
      const sicherung = path.join(ordner, `sicherung-vor-tabellen-${jetzt.toISOString().replace(/[:.]/g, '-')}.json`)
      fs.writeFileSync(sicherung, JSON.stringify({ zeit: jetzt.toISOString(), stand, protokoll }), 'utf8')

      const kandidat = tabellenSpeicherMachen({ datenbank: ctx.datenbank, schema, journalDatei: optionen.journalDatei || null })
      await kandidat.laden()
      if (!kandidat.istLeer()) {
        return { ok: false, text: 'In den Datenbank-Tabellen stehen schon Daten. Übernahme abgebrochen, nichts geändert.' }
      }
      neu = kandidat // ab hier gehören die Tabellen der Übernahme und werden bei einem Abbruch geleert
      neu.speichern(stand)
      neu.protokollUebernehmen(protokoll)
      await neu.festschreiben()

      // Frisch aus den Tabellen lesen und vollständig vergleichen
      const probe = tabellenSpeicherMachen({ datenbank: ctx.datenbank, schema })
      await probe.laden()
      const probeProtokoll = probe.protokollLesen({ anzahl: PROTOKOLL_ALLE }).reverse()
      const soll = zaehlen(stand, protokoll)
      const ist = zaehlen(probe.lesen(), probeProtokoll)
      const gleich = kanonisch(vervollstaendigen(probe.lesen())) === kanonisch(stand) && kanonisch(probeProtokoll) === kanonisch(protokoll)
      if (!gleich || kanonisch(soll) !== kanonisch(ist)) {
        await neu.leeren().catch(() => {})
        neu = null
        return { ok: false, text: 'Der Abgleich nach dem Kopieren stimmt nicht. Tabellen wieder geleert, es bleibt beim bisherigen Speicher.', soll, ist }
      }

      // Erst jetzt umschalten: Markierung in den Plugin-Daten, dann den neuen Speicher nehmen
      ctx.datenSpeichern({ [MARKIERUNG]: { modus: 'tabellen', uebernommenAm: jetzt.toISOString(), sicherung: path.basename(sicherung), zaehlung: ist } })
      if (typeof ctx.festschreiben === 'function') await ctx.festschreiben()
      const fertig = huelle(neu)
      tabellenInstanzen.set(schema, fertig)
      aktuell = fertig
      neu = null
      return {
        ok: true,
        text: `Übernommen: ${ist.kontakte} Kontakte, ${ist.kampagnen} Kampagnen, ${ist.automationen} Automationen, ${ist.protokoll} Protokollzeilen. Sicherung: ${path.basename(sicherung)}.`,
        zaehlung: ist,
        sicherung: path.basename(sicherung)
      }
    } catch (f) {
      if (neu) await neu.leeren().catch(() => {})
      return { ok: false, text: `Übernahme abgebrochen, es bleibt beim bisherigen Speicher: ${f.message}` }
    } finally {
      uebernahme = null
      freigeben()
    }
  }

  return w
}

module.exports = { speicherMachen, vervollstaendigen, modusVon, kanonisch, zaehlen, LISTEN, BEREICHE, MARKIERUNG }
