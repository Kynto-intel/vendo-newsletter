'use strict'
// Newsletter-Plugin: der einzige Zugang zu den gespeicherten Daten.
//
// Schritt N1 des PostgreSQL-Umbaus: Alles Lesen und Schreiben läuft hier durch. Dahinter liegt vorerst Vendos
// gemeinsamer Plugin-Speicher (`ctx.datenLaden`/`ctx.datenSpeichern`, in Vendo ein jsonb-Feld in PostgreSQL). Später
// liest und schreibt dieses Modul eigene Tabellen; der Rest des Plugins merkt davon nichts.
//
// `festschreiben` wartet, bis der Stand dauerhaft liegt: in der Datenbank oder, wenn sie nicht erreichbar ist, in
// Vendos Journal (`daten/speicher-offen/`), das beim nächsten Start nachgeschrieben wird. Es gehört vor jeden Schritt
// nach außen, der sich nicht zurücknehmen lässt (SMTP-Versand, Mails im Postfach als gelesen markieren). Ohne
// `ctx.festschreiben` (Tests, ältere Vendo-Versionen) tut es nichts.

const LISTEN = ['warteschlange', 'kontakte', 'kampagnen', 'vorlagen', 'automationen', 'laeufe', 'ruecklaeufer']
const BEREICHE = ['zugang', 'shopify', 'einstellungen', 'marke', 'drossel']

// Gespeicherte Daten in die Form bringen, die der Rest erwartet: jede Liste ist eine Liste, jeder Bereich ein Objekt
function vervollstaendigen(roh) {
  const d = roh && typeof roh === 'object' ? roh : {}
  const aus = { ...d }
  for (const b of BEREICHE) aus[b] = d[b] || {}
  for (const l of LISTEN) aus[l] = Array.isArray(d[l]) ? d[l] : []
  return aus
}

function speicherMachen(ctx) {
  const lesen = () => vervollstaendigen(ctx.datenLaden())
  const speichern = (daten) => ctx.datenSpeichern(daten)
  const feldSpeichern = (feld, wert) => {
    const d = lesen()
    d[feld] = wert
    speichern(d)
  }
  const festschreiben = async () => {
    if (typeof ctx.festschreiben !== 'function') return
    try {
      await ctx.festschreiben()
    } catch {
      // Vendo hat den Stand dann ins Journal geschrieben und schreibt ihn nach; er ist also nicht verloren
    }
  }
  return { lesen, speichern, feldSpeichern, festschreiben }
}

module.exports = { speicherMachen, vervollstaendigen, LISTEN, BEREICHE }
