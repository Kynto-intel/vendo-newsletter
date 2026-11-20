'use strict'
// Newsletter-Plugin: fertige Vorlagen im Stil der Marke.
//
// Die Vorlagen liegen als gewöhnliches HTML in `vorlagen/`, eine Datei je Muster. Man
// kann sie dort von Hand ändern, ohne Code anzufassen; dieses Modul liest sie nur ein und
// setzt die Platzhalter. Eine neue Datei im Ordner ist ein neues Muster, ohne Codeänderung.
//
// `vorlagen/` enthält neutrale Beispiele (öffentlich im Repository). Eigene Muster im Stil
// der eigenen Marke gehören nach `vorlagen-eigene/`: der Ordner ist von Git ausgeschlossen,
// und eine Datei dort ersetzt das gleichnamige Muster aus `vorlagen/` oder kommt dazu.
//
// In Vendo erscheinen die Muster direkt als Vorlagen, nicht als zweite Liste daneben. Eine
// eigene Kopie in den Plugin-Daten entsteht erst, wenn jemand eine davon wirklich ändert
// (siehe `vorlageZumAendern` in haupt.js) — dann steht die Kopie an Stelle des Musters.
//
// Warum es die Muster überhaupt gibt: Vor einem leeren Feld baut auch eine gute KI nur ein
// Gerüst und füllt es mit denselben drei Produkten. Mit einer fertigen Vorlage bleibt ihr
// das, was sie kann — Texte schreiben und echte Produkte einsetzen.
//
// Die Dateien halten sich an Vendos eigene Regeln, und die Tests halten sie darauf fest:
// kein Logo, kein Fuß, keine eigene 600-px-Hülle, kein Bild ohne Adresse, kein Knopf ohne
// Ziel, kein Streichpreis ohne echten Vergleichspreis, kein Bild und kein Produkt doppelt.

const fs = require('fs')
const path = require('path')
const { STANDARD_FARBEN, SCHRIFT } = require('./bausteine.js')

const ORDNER = path.join(__dirname, 'vorlagen')
// Eigene Muster (lokal, nicht in Git). Tests lenken das über VENDO_NEWSLETTER_EIGENE_VORLAGEN um.
const EIGENE = () => process.env.VENDO_NEWSLETTER_EIGENE_VORLAGEN || path.join(__dirname, 'vorlagen-eigene')
const ordnerListe = () => [ORDNER, EIGENE()]

// Die Farben, die in den Dateien stehen: Anthrazit und Gold, Beige als heller Kontrast.
// Sie sind zugleich die Marken, nach denen ersetzt wird: stehen in den Markenangaben
// eigene Farben, tauscht `ersetzen` Wert für Wert. Deshalb muss jeder
// Wert hier einmalig sein, sonst bekämen zwei Rollen dieselbe neue Farbe.
const DUNKEL = {
  hintergrund: '#111111',
  flaeche: '#1A1A1A',
  text: '#D9CBB4',
  leise: '#9A8F7C',
  akzent: '#C29A40',
  aufAkzent: '#15120B',
  linie: '#333333'
}

const SHOP = 'https://beispiel-shop.de'

// Beispielprodukte, wie sie in den Dateien stehen. Die Bildflächen zeigen auf das
// gezeichnete Platzhalterbild (icons.js): in der Vorschau sieht man einen Rahmen mit
// „BILD" statt eines kaputten Bildsymbols, und Vendos Prüfung lässt `cid:` durch.
const BEISPIEL = [
  { name: 'Beispiel Hoodie', preis: '59,99 €', pfad: 'beispiel-hoodie' },
  { name: 'Beispiel T-Shirt', preis: '24,95 €', pfad: 'beispiel-shirt' },
  { name: 'Beispiel Sweatshirt', preis: '49,95 €', pfad: 'beispiel-sweatshirt' },
  { name: 'Beispiel Hoodie, zweite Farbe', preis: '59,99 €', pfad: 'beispiel-hoodie-zwei' }
]

// Kopfzeilen der Datei: <!-- name: … -->
function kopfLesen(text, feld) {
  const treffer = String(text).match(new RegExp(`<!--\\s*${feld}:\\s*([^>]*?)\\s*-->`, 'i'))
  return treffer ? treffer[1].trim() : ''
}

// Alle Kommentare entfernen: die Kopfzeilen und die Anleitung gehören nicht in die Mail.
const kommentareWeg = (text) => String(text).replace(/<!--[\s\S]*?-->/g, '').trim()

// Dateinamen aus beiden Ordnern; ein fehlender Ordner hat eben keine Muster. Ein
// gleichnamiges eigenes Muster ersetzt das Beispiel.
function dateienFinden() {
  const nachName = new Map()
  for (const ordner of ordnerListe()) {
    let namen = []
    try {
      namen = fs.readdirSync(ordner).filter((n) => n.toLowerCase().endsWith('.html'))
    } catch {
      continue
    }
    for (const n of namen) nachName.set(n, path.join(ordner, n))
  }
  return [...nachName.entries()].sort(([a], [b]) => a.localeCompare(b))
}

function dateienLesen() {
  const gefunden = []
  for (const [datei, pfad] of dateienFinden()) {
    let roh
    try {
      roh = fs.readFileSync(pfad, 'utf8')
    } catch {
      continue
    }
    const id = path.basename(datei, '.html')
    const name = kopfLesen(roh, 'name') || id
    const art = kopfLesen(roh, 'art') || 'kampagne'
    const beschreibung = kopfLesen(roh, 'beschreibung')
    gefunden.push({ id, name, art, beschreibung, roh, datei })
  }
  // Reihenfolge wie gewünscht: erst die Newsletter, dann Warenkorb, dann Willkommen
  const rang = { kampagne: 0, warenkorb: 1, willkommen: 2 }
  return gefunden.sort((a, b) => (rang[a.art] ?? 9) - (rang[b.art] ?? 9) || a.name.localeCompare(b.name, 'de'))
}

// Die Muster sind in Vendo zugleich Vorlagen — eine geänderte Datei soll also ohne
// Neustart wirken. Neu gelesen wird nur, wenn sich Name, Zeit oder Größe einer Datei
// geändert haben, und das wird höchstens alle zwei Sekunden nachgesehen.
const PRUEF_ABSTAND = 2000
let zwischen = { schluessel: null, liste: [], geprueftAm: 0 }

function stempel() {
  return dateienFinden()
    .map(([n, pfad]) => {
      try {
        const s = fs.statSync(pfad)
        return `${pfad}:${s.mtimeMs}:${s.size}`
      } catch {
        return n
      }
    })
    .join('|')
}

function gelesen() {
  const jetzt = Date.now()
  if (zwischen.schluessel !== null && jetzt - zwischen.geprueftAm < PRUEF_ABSTAND) return zwischen.liste
  const schluessel = stempel()
  if (schluessel !== zwischen.schluessel) zwischen = { schluessel, liste: dateienLesen(), geprueftAm: jetzt }
  else zwischen.geprueftAm = jetzt
  return zwischen.liste
}

const hexOk = (wert) => (/^#[0-9a-f]{3,8}$/i.test(String(wert || '').trim()) ? String(wert).trim() : '')

function farbenAus(marke = {}) {
  const eigene = {}
  for (const [name, wert] of Object.entries(marke?.farben || {})) {
    if (hexOk(wert)) eigene[name] = wert
  }
  return { ...STANDARD_FARBEN, ...DUNKEL, ...eigene }
}

// Die Dateien enthalten gültiges HTML mit echten Werten — kein `%TOKEN%`, sonst meldet
// jeder Editor ungültiges CSS und die Datei lässt sich nicht im Browser ansehen. Ersetzt
// wird deshalb Wert für Wert: die sieben Farben und die Shop-Adresse.
function ersetzen(roh, { marke = {}, shop = SHOP } = {}) {
  const ziel = farbenAus(marke)
  let text = String(roh)
  for (const [rolle, standard] of Object.entries(DUNKEL)) {
    if (!ziel[rolle] || ziel[rolle].toLowerCase() === standard.toLowerCase()) continue
    text = text.split(standard).join(ziel[rolle])
    text = text.split(standard.toUpperCase()).join(ziel[rolle])
  }
  const eigenerShop = String(shop || '').replace(/\/$/, '')
  if (eigenerShop && eigenerShop !== SHOP) text = text.split(SHOP).join(eigenerShop)
  return text
}

// Ein Muster als fertiges HTML. Unbekannte Kennung gibt null, damit der Aufrufer es merkt.
function musterHtml(id, angaben = {}) {
  const muster = gelesen().find((x) => x.id === id)
  if (!muster) return null
  return ersetzen(kommentareWeg(muster.roh), angaben)
}

// Die Liste für die Oberfläche und für den Bot — ohne das rohe HTML.
const musterListe = () => gelesen().map(({ id, name, art, beschreibung }) => ({ id, name, art, beschreibung }))

module.exports = { musterListe, musterHtml, ersetzen, farbenAus, kopfLesen, kommentareWeg, ORDNER, EIGENE, DUNKEL, BEISPIEL, SHOP }
