'use strict'
// Newsletter-Plugin: Speicher auf eigenen Tabellen in PostgreSQL (Schritt N3 des PostgreSQL-Umbaus).
//
// Dieselbe Schnittstelle wie der bisherige Speicher (lesen, speichern, feldSpeichern, festschreiben), damit haupt.js
// nichts davon merkt. Beim Start werden alle Tabellen in einen Zwischenspeicher gelesen; Lesen bleibt dadurch
// synchron. `speichern` ändert den Zwischenspeicher sofort und schreibt kurz danach nur die geänderten Zeilen zurück,
// alles aus einem Durchgang in einer Transaktion. `festschreiben` wartet, bis das geschehen ist.
//
// Ist die Datenbank beim Schreiben nicht erreichbar, landet der ganze Stand in einer Journaldatei; nach 10 Sekunden
// wird erneut versucht, und beim nächsten Start gilt das Journal vor den Tabellen. Gelöscht wird es erst, wenn der
// Stand in der Datenbank liegt.
//
// Das Versandprotokoll ist eine eigene Tabelle (eine Zeile je Mail) und wird im selben Durchgang geschrieben.
//
// Vendo ist der einzige Schreiber dieser Tabellen (ein Prozess). Wer später parallel versenden will (Teil S, Server),
// muss die Warteschlange mit `SELECT … FOR UPDATE SKIP LOCKED` direkt in der Datenbank verteilen; mit einem einzigen
// Schreiber reicht der Zwischenspeicher.

const fs = require('node:fs')
const path = require('node:path')
const { SCHEMA, migrationen, schemaPruefen, TABELLEN, BESTELLUNGEN } = require('./db.js')
const { protokollZeile } = require('./protokoll.js')

const SAMMELPAUSE = 50 // ms: mehrere Speichervorgänge kurz hintereinander werden ein Durchgang
const WIEDERHOLEN = 10_000
const PAKET = 1000 // Zeilen je INSERT
const PROTOKOLL_MAX = 100_000 // so viele Protokollzeilen hält der Zwischenspeicher (die neuesten)

const kopie = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)))

// Zeilen einer Liste: Schlüssel aus dem Objekt, sonst (fehlend oder doppelt) aus der Position
function zeilenAus(liste, def) {
  const zeilen = new Map()
  ;(Array.isArray(liste) ? liste : []).forEach((eintrag, position) => {
    let schluessel = def.schluessel(eintrag)
    if (!schluessel || zeilen.has(schluessel)) schluessel = `@${position}`
    const spalten = {}
    if (eintrag && typeof eintrag === 'object') for (const [name, fn] of Object.entries(def.spalten)) spalten[name] = fn(eintrag)
    zeilen.set(schluessel, { schluessel, position, json: JSON.stringify(eintrag), spalten })
  })
  return zeilen
}

// Den ganzen Stand in Tabellenzeilen zerlegen (ohne Datenbank, testbar)
function zerlegen(stand) {
  const d = stand && typeof stand === 'object' ? stand : {}
  const listen = {}
  for (const [name, def] of Object.entries(TABELLEN)) listen[name] = zeilenAus(d[name], def)
  const ergebnisse = d.ergebnisse && typeof d.ergebnisse === 'object' ? d.ergebnisse : null
  listen.ergebnis_bestellungen = zeilenAus(ergebnisse?.bestellungen, BESTELLUNGEN)
  const namen = new Map()
  for (const [kurz, wert] of Object.entries(ergebnisse?.namen && typeof ergebnisse.namen === 'object' ? ergebnisse.namen : {})) namen.set(kurz, JSON.stringify(wert))
  const einstellungen = new Map()
  for (const [schluessel, wert] of Object.entries(d)) {
    if (TABELLEN[schluessel] || wert === undefined) continue
    if (schluessel === 'ergebnisse') {
      if (!ergebnisse) continue
      const { namen: _n, bestellungen: _b, ...rest } = ergebnisse
      einstellungen.set('ergebnisse', JSON.stringify(rest))
      continue
    }
    einstellungen.set(schluessel, JSON.stringify(wert))
  }
  return { listen, namen, einstellungen }
}

// Was zwischen zwei Zerlegungen geschrieben und gelöscht werden muss
function unterschied(alt, neu) {
  const plan = { listen: {}, namen: { schreiben: [], loeschen: [] }, einstellungen: { schreiben: [], loeschen: [] }, leer: true }
  for (const [tabelle, zeilen] of Object.entries(neu.listen)) {
    const vorher = alt?.listen?.[tabelle] || new Map()
    const schreiben = []
    for (const z of zeilen.values()) {
      const v = vorher.get(z.schluessel)
      if (!v || v.json !== z.json || v.position !== z.position) schreiben.push(z)
    }
    const loeschen = [...vorher.keys()].filter((k) => !zeilen.has(k))
    plan.listen[tabelle] = { schreiben, loeschen }
    if (schreiben.length || loeschen.length) plan.leer = false
  }
  for (const art of ['namen', 'einstellungen']) {
    const vorher = alt?.[art] || new Map()
    for (const [k, json] of neu[art]) if (vorher.get(k) !== json) plan[art].schreiben.push([k, json])
    for (const k of vorher.keys()) if (!neu[art].has(k)) plan[art].loeschen.push(k)
    if (plan[art].schreiben.length || plan[art].loeschen.length) plan.leer = false
  }
  return plan
}

// Spaltentypen für jsonb_to_recordset (Text, wenn nicht anders angegeben)
const TYPEN = { gesperrt: 'boolean', aktiv: 'boolean', faellig_ab: 'bigint', sendet_seit: 'bigint', am: 'bigint', betrag: 'numeric' }
const DEFS = { ...TABELLEN, ergebnis_bestellungen: BESTELLUNGEN }

async function listeSchreiben(c, schema, tabelle, { schreiben, loeschen }) {
  if (loeschen.length) await c.query(`DELETE FROM ${schema}.${tabelle} WHERE schluessel = ANY($1::text[])`, [loeschen])
  if (!schreiben.length) return
  const spalten = Object.keys(DEFS[tabelle].spalten)
  const alle = ['schluessel', 'position', 'daten', ...spalten]
  const typen = ['schluessel text', 'position int', 'daten jsonb', ...spalten.map((s) => `${s} ${TYPEN[s] || 'text'}`)]
  const setzen = alle.filter((s) => s !== 'schluessel').map((s) => `${s} = EXCLUDED.${s}`)
  for (let i = 0; i < schreiben.length; i += PAKET) {
    const paket = schreiben.slice(i, i + PAKET).map((z) => ({ schluessel: z.schluessel, position: z.position, daten: JSON.parse(z.json), ...z.spalten }))
    await c.query(
      `INSERT INTO ${schema}.${tabelle} (${alle.join(', ')})
       SELECT ${alle.join(', ')} FROM jsonb_to_recordset($1::jsonb) AS x(${typen.join(', ')})
       ON CONFLICT (schluessel) DO UPDATE SET ${setzen.join(', ')}, geaendert_am = now()`,
      [JSON.stringify(paket)]
    )
  }
}

async function paareSchreiben(c, schema, tabelle, spalte, wertSpalte, { schreiben, loeschen }) {
  if (loeschen.length) await c.query(`DELETE FROM ${schema}.${tabelle} WHERE ${spalte} = ANY($1::text[])`, [loeschen])
  for (const [k, json] of schreiben) {
    await c.query(
      `INSERT INTO ${schema}.${tabelle} (${spalte}, ${wertSpalte}) VALUES ($1, $2::jsonb)
       ON CONFLICT (${spalte}) DO UPDATE SET ${wertSpalte} = EXCLUDED.${wertSpalte}, geaendert_am = now()`,
      [k, json]
    )
  }
}

async function protokollEinfuegen(c, schema, zeilen) {
  for (let i = 0; i < zeilen.length; i += PAKET) {
    const paket = zeilen.slice(i, i + PAKET).map((z) => ({ zeit: z.zeit, an_adresse: z.an, betreff: z.betreff, art: z.art, kampagne_id: z.kampagneId, ok: Boolean(z.ok), fehler: z.fehler }))
    await c.query(
      `INSERT INTO ${schema}.protokoll (zeit, an_adresse, betreff, art, kampagne_id, ok, fehler)
       SELECT zeit, an_adresse, betreff, art, kampagne_id, ok, fehler
       FROM jsonb_to_recordset($1::jsonb) AS x(zeit timestamptz, an_adresse text, betreff text, art text, kampagne_id text, ok boolean, fehler text)`,
      [JSON.stringify(paket)]
    )
  }
}

// Den Stand aus den Tabellen zusammensetzen
async function tabellenLesen(datenbank, schema) {
  const stand = {}
  const zeilenVon = async (tabelle) => (await datenbank.abfrage(`SELECT daten FROM ${schema}.${tabelle} ORDER BY position, schluessel`)).rows.map((r) => r.daten)
  for (const tabelle of Object.keys(TABELLEN)) stand[tabelle] = await zeilenVon(tabelle)
  const einstellungen = (await datenbank.abfrage(`SELECT schluessel, wert FROM ${schema}.einstellungen`)).rows
  for (const r of einstellungen) if (r.schluessel !== 'ergebnisse') stand[r.schluessel] = r.wert
  const ergebnisRest = einstellungen.find((r) => r.schluessel === 'ergebnisse')
  if (ergebnisRest) {
    const namen = Object.fromEntries((await datenbank.abfrage(`SELECT kurz, daten FROM ${schema}.ergebnis_namen`)).rows.map((r) => [r.kurz, r.daten]))
    stand.ergebnisse = { ...ergebnisRest.wert, namen, bestellungen: await zeilenVon('ergebnis_bestellungen') }
  }
  const protokoll = (await datenbank.abfrage(`SELECT zeit, an_adresse, betreff, art, kampagne_id, ok, fehler FROM ${schema}.protokoll ORDER BY id DESC LIMIT ${PROTOKOLL_MAX}`)).rows
    .reverse()
    .map((r) => ({ zeit: new Date(r.zeit).toISOString(), an: r.an_adresse, betreff: r.betreff, art: r.art, kampagneId: r.kampagne_id, ok: r.ok, fehler: r.fehler }))
  return { stand, protokoll }
}

function tabellenSpeicherMachen({ datenbank, schema = SCHEMA, journalDatei = null } = {}) {
  schemaPruefen(schema)
  let stand = null // der Zwischenspeicher; null, solange nicht geladen
  let geschrieben = null // Zerlegung dessen, was in den Tabellen steht
  let protokoll = [] // älteste zuerst
  let protokollOffen = [] // noch nicht geschriebene Protokollzeilen
  let schmutzig = false
  let laufend = null
  let zeitgeber = null
  let wiederholung = null
  let letzterFehler = null
  let fertig
  const bereit = new Promise((aufloesen) => { fertig = aufloesen })

  const journalLesen = () => {
    if (!journalDatei) return null
    try { return JSON.parse(fs.readFileSync(journalDatei, 'utf8')) } catch { return null }
  }
  const journalSchreiben = () => {
    if (!journalDatei) return
    try {
      fs.mkdirSync(path.dirname(journalDatei), { recursive: true })
      const tmp = `${journalDatei}.neu`
      fs.writeFileSync(tmp, JSON.stringify({ zeit: new Date().toISOString(), stand, protokollOffen }), 'utf8')
      fs.renameSync(tmp, journalDatei)
    } catch (f) {
      console.warn(`Newsletter: Journal nicht schreibbar: ${f.message}`)
    }
  }
  const journalLoeschen = () => {
    if (journalDatei) try { fs.rmSync(journalDatei, { force: true }) } catch {}
  }

  async function laden() {
    await datenbank.migrieren(migrationen(schema))
    const gelesen = await tabellenLesen(datenbank, schema)
    geschrieben = zerlegen(gelesen.stand)
    stand = gelesen.stand
    protokoll = gelesen.protokoll
    // Ein Journal ist neuer als die Tabellen: es entsteht nur, wenn das Schreiben scheiterte
    const journal = journalLesen()
    if (journal?.stand) {
      stand = journal.stand
      protokollOffen = Array.isArray(journal.protokollOffen) ? journal.protokollOffen : []
      protokoll.push(...protokollOffen)
      schmutzig = true
      console.warn('Newsletter: Journal vom letzten Lauf übernommen, wird nachgeschrieben.')
    }
    fertig()
    if (schmutzig) await festschreiben().catch(() => {})
    return { geladen: true }
  }

  const istBereit = () => stand !== null
  const nichtGeladen = () => new Error('Die Newsletter-Daten werden noch aus der Datenbank geladen.')

  async function durchgang() {
    while (schmutzig) {
      schmutzig = false
      const neu = zerlegen(stand)
      const plan = unterschied(geschrieben, neu)
      const zeilen = protokollOffen.slice() // was danach dazukommt, schreibt der nächste Durchgang
      if (plan.leer && !zeilen.length) continue
      try {
        await datenbank.transaktion(async (c) => {
          for (const [tabelle, aenderung] of Object.entries(plan.listen)) await listeSchreiben(c, schema, tabelle, aenderung)
          await paareSchreiben(c, schema, 'ergebnis_namen', 'kurz', 'daten', plan.namen)
          await paareSchreiben(c, schema, 'einstellungen', 'schluessel', 'wert', plan.einstellungen)
          if (zeilen.length) await protokollEinfuegen(c, schema, zeilen)
        })
        geschrieben = neu
        protokollOffen = protokollOffen.slice(zeilen.length)
        letzterFehler = null
        if (!schmutzig && !protokollOffen.length) journalLoeschen()
      } catch (f) {
        schmutzig = true
        letzterFehler = f.message
        journalSchreiben()
        if (!wiederholung) wiederholung = setTimeout(() => { wiederholung = null; festschreiben().catch(() => {}) }, WIEDERHOLEN)
        wiederholung.unref?.()
        throw f
      }
    }
  }

  function festschreiben() {
    if (!istBereit()) return bereit.then(() => festschreiben())
    if (zeitgeber) { clearTimeout(zeitgeber); zeitgeber = null }
    // Ein laufender Durchgang nimmt neue Änderungen in seiner Schleife mit; auf ihn zu warten genügt
    if (!laufend) laufend = durchgang().finally(() => { laufend = null })
    return laufend
  }

  function anstossen() {
    schmutzig = true
    if (zeitgeber || laufend) {
      // Läuft schon ein Durchgang, nimmt seine Schleife den neuen Stand mit
      return
    }
    zeitgeber = setTimeout(() => { zeitgeber = null; festschreiben().catch(() => {}) }, SAMMELPAUSE)
    zeitgeber.unref?.()
  }

  const lesen = () => {
    if (!istBereit()) throw nichtGeladen()
    return kopie(stand)
  }
  const speichern = (daten) => {
    if (!istBereit()) throw nichtGeladen()
    stand = kopie(daten)
    anstossen()
  }

  const protokollSchreiben = (eintrag) => {
    if (!istBereit()) return null
    const zeile = protokollZeile(eintrag)
    protokoll.push(zeile)
    if (protokoll.length > PROTOKOLL_MAX) protokoll = protokoll.slice(-PROTOKOLL_MAX)
    protokollOffen.push(zeile)
    anstossen()
    return zeile
  }
  // Neueste zuerst, wie die Monatsdateien
  const protokollLesen = ({ anzahl = 50 } = {}) => (istBereit() ? protokoll.slice(-Math.max(0, anzahl)).reverse().map((z) => ({ ...z })) : [])

  // Für die Übernahme (Schritt N4): fertige Protokollzeilen unverändert übernehmen (Adressen sind schon gekürzt)
  const protokollUebernehmen = (zeilen) => {
    if (!istBereit()) throw nichtGeladen()
    const liste = (Array.isArray(zeilen) ? zeilen : []).filter((z) => z && typeof z === 'object' && z.zeit)
    protokoll.push(...liste)
    protokollOffen.push(...liste)
    if (liste.length) anstossen()
    return liste.length
  }
  // Sind die Tabellen leer? Die Übernahme schreibt nur in leere Tabellen.
  const istLeer = () => {
    if (!istBereit()) throw nichtGeladen()
    const z = zerlegen(stand)
    return protokoll.length === 0 && z.namen.size === 0 && z.einstellungen.size === 0 && Object.values(z.listen).every((m) => m.size === 0)
  }
  // Alle Zeilen löschen (nur für eine abgebrochene Übernahme); danach ist der Speicher leer und nicht mehr nutzbar
  async function leeren() {
    if (zeitgeber) { clearTimeout(zeitgeber); zeitgeber = null }
    if (wiederholung) { clearTimeout(wiederholung); wiederholung = null }
    if (laufend) await laufend.catch(() => {})
    schmutzig = false
    protokollOffen = []
    await datenbank.transaktion(async (c) => {
      for (const t of [...Object.keys(TABELLEN), 'ergebnis_bestellungen', 'ergebnis_namen', 'einstellungen', 'protokoll']) await c.query(`DELETE FROM ${schema}.${t}`)
    })
    journalLoeschen()
    stand = null
  }

  const zustand = () => ({ modus: 'tabellen', geladen: istBereit(), offen: schmutzig || protokollOffen.length > 0, letzterFehler })

  return { modus: 'tabellen', laden, bereit, istBereit, lesen, speichern, festschreiben, protokollSchreiben, protokollLesen, protokollUebernehmen, istLeer, leeren, zustand }
}

module.exports = { tabellenSpeicherMachen, zerlegen, unterschied, tabellenLesen, PROTOKOLL_MAX }
