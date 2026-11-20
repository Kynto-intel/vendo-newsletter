'use strict'
// Newsletter-Plugin: Schema und Migrationen in PostgreSQL (Schritt N2 des PostgreSQL-Umbaus).
//
// Jede Liste der Plugin-Daten bekommt eine eigene Tabelle. Jede Zeile trägt das vollständige Objekt in `daten`
// (jsonb): so geht beim Hin und Zurück kein Feld verloren, auch keines, das später dazukommt. Daneben stehen die
// Felder, nach denen gesucht, gefiltert oder sortiert wird, als eigene Spalten mit Index. Sie werden beim Schreiben
// aus dem Objekt abgeleitet und sind nie maßgeblich. `position` hält die Reihenfolge der Liste.
//
// Alles, was keine Liste ist (Zugang, Shopify, Marke, Drossel, Einstellungen, Bot-Stände …), liegt als ein Eintrag je
// Schlüssel in `einstellungen`. Das Versandprotokoll ist eine echte Tabelle (eine Zeile je Mail).
//
// Das Schema heißt im Betrieb wie das Plugin: `newsletter`. Tests geben ein eigenes Schema an, damit parallel laufende
// Testdateien sich nicht stören.

const SCHEMA = 'newsletter'
const NAME = /^[a-z_][a-z0-9_]{0,40}$/

function schemaPruefen(schema) {
  if (!NAME.test(String(schema))) throw new Error(`Ungültiger Schemaname: ${schema}`)
  return schema
}

// Gemeinsame Spalten jeder Listentabelle
const LISTE = 'schluessel text PRIMARY KEY, position int NOT NULL, daten jsonb NOT NULL, geaendert_am timestamptz NOT NULL DEFAULT now()'

function migrationen(schema = SCHEMA) {
  const s = schemaPruefen(schema)
  return [
    {
      version: 1,
      sql: `
        CREATE SCHEMA IF NOT EXISTS ${s};
        CREATE TABLE IF NOT EXISTS ${s}.kontakte (${LISTE},
          email text, shopify_id text, quelle text, zustand text, zustimmung_am text,
          gesperrt boolean NOT NULL DEFAULT false, sperr_art text);
        CREATE INDEX IF NOT EXISTS kontakte_gesperrt ON ${s}.kontakte (gesperrt);
        CREATE INDEX IF NOT EXISTS kontakte_shopify_id ON ${s}.kontakte (shopify_id);
        CREATE TABLE IF NOT EXISTS ${s}.kampagnen (${LISTE}, name text, zustand text, utm text);
        CREATE INDEX IF NOT EXISTS kampagnen_zustand ON ${s}.kampagnen (zustand);
        CREATE TABLE IF NOT EXISTS ${s}.vorlagen (${LISTE}, name text);
        CREATE TABLE IF NOT EXISTS ${s}.automationen (${LISTE}, name text, ausloeser text, aktiv boolean NOT NULL DEFAULT false);
        CREATE TABLE IF NOT EXISTS ${s}.laeufe (${LISTE}, automation_id text, email text, zustand text, lauf_schluessel text);
        CREATE INDEX IF NOT EXISTS laeufe_lauf_schluessel ON ${s}.laeufe (lauf_schluessel);
        CREATE INDEX IF NOT EXISTS laeufe_zustand ON ${s}.laeufe (zustand);
        CREATE TABLE IF NOT EXISTS ${s}.warteschlange (${LISTE},
          eintrag_schluessel text, kampagne_id text, an_adresse text, art text, zustand text,
          faellig_ab bigint, sendet_seit bigint);
        CREATE INDEX IF NOT EXISTS warteschlange_faellig ON ${s}.warteschlange (zustand, faellig_ab);
        CREATE INDEX IF NOT EXISTS warteschlange_eintrag ON ${s}.warteschlange (eintrag_schluessel);
        CREATE TABLE IF NOT EXISTS ${s}.ruecklaeufer (${LISTE}, am bigint, email text, art text);
        CREATE INDEX IF NOT EXISTS ruecklaeufer_email ON ${s}.ruecklaeufer (email);
        CREATE TABLE IF NOT EXISTS ${s}.ergebnis_namen (kurz text PRIMARY KEY, daten jsonb NOT NULL,
          geaendert_am timestamptz NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS ${s}.ergebnis_bestellungen (${LISTE}, kurz text, betrag numeric(12,2), waehrung text, am bigint);
        CREATE INDEX IF NOT EXISTS ergebnis_bestellungen_kurz ON ${s}.ergebnis_bestellungen (kurz);
        CREATE TABLE IF NOT EXISTS ${s}.einstellungen (schluessel text PRIMARY KEY, wert jsonb NOT NULL,
          geaendert_am timestamptz NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS ${s}.protokoll (
          id bigserial PRIMARY KEY, zeit timestamptz NOT NULL, an_adresse text, betreff text, art text,
          kampagne_id text, ok boolean NOT NULL, fehler text);
        CREATE INDEX IF NOT EXISTS protokoll_zeit ON ${s}.protokoll (zeit);
        CREATE INDEX IF NOT EXISTS protokoll_kampagne ON ${s}.protokoll (kampagne_id);`
    }
  ]
}

// Text oder null; Zahlen als ganze Zahl oder null (für bigint-Spalten mit Millisekunden)
const text = (x) => (x === undefined || x === null || x === '' ? null : String(x))
const ganz = (x) => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Math.trunc(Number(x)) : null)
const betrag = (x) => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Math.round(Number(x) * 100) / 100 : null)

// Die Listentabellen: woher der Schlüssel kommt und welche Spalten aus dem Objekt abgeleitet werden.
// Ein fehlender oder doppelter Schlüssel fällt auf die Position zurück (siehe speicher-tabellen.js).
const TABELLEN = {
  kontakte: {
    schluessel: (k) => text(k?.email)?.toLowerCase() || null,
    spalten: {
      email: (k) => text(k.email)?.toLowerCase() ?? null,
      shopify_id: (k) => text(k.shopifyId),
      quelle: (k) => text(k.quelle),
      zustand: (k) => text(k.zustand),
      zustimmung_am: (k) => text(k.zustimmungAm),
      gesperrt: (k) => Boolean(k.gesperrt),
      sperr_art: (k) => text(k.sperrArt)
    }
  },
  kampagnen: {
    schluessel: (k) => text(k?.id),
    spalten: { name: (k) => text(k.name), zustand: (k) => text(k.zustand), utm: (k) => text(k.utm) }
  },
  vorlagen: { schluessel: (v) => text(v?.id), spalten: { name: (v) => text(v.name) } },
  automationen: {
    schluessel: (a) => text(a?.id),
    spalten: { name: (a) => text(a.name), ausloeser: (a) => text(a.ausloeser), aktiv: (a) => Boolean(a.aktiv) }
  },
  laeufe: {
    schluessel: (l) => text(l?.id),
    spalten: {
      automation_id: (l) => text(l.automationId),
      email: (l) => text(l.email),
      zustand: (l) => text(l.zustand),
      lauf_schluessel: (l) => text(l.schluessel)
    }
  },
  warteschlange: {
    schluessel: (e) => text(e?.id),
    spalten: {
      eintrag_schluessel: (e) => text(e.schluessel),
      kampagne_id: (e) => text(e.kampagneId),
      an_adresse: (e) => text(e.an),
      art: (e) => text(e.art),
      zustand: (e) => text(e.zustand),
      faellig_ab: (e) => ganz(e.faelligAb),
      sendet_seit: (e) => ganz(e.sendetSeit)
    }
  },
  // Rückläufer-Ereignisse haben keine eigene Kennung: Schlüssel ist die Position
  ruecklaeufer: {
    schluessel: () => null,
    spalten: { am: (e) => ganz(e.am), email: (e) => text(e.email), art: (e) => text(e.art) }
  }
}

// Die Bestellungen unter `ergebnisse` sind ebenfalls eine Liste mit eigener Tabelle
const BESTELLUNGEN = {
  schluessel: (b) => text(b?.id),
  spalten: { kurz: (b) => text(b.kurz), betrag: (b) => betrag(b.betrag), waehrung: (b) => text(b.waehrung), am: (b) => ganz(b.am) }
}

module.exports = { SCHEMA, migrationen, schemaPruefen, TABELLEN, BESTELLUNGEN }
