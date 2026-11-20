'use strict'
// Test-Datenbank für die Newsletter-Tests: dieselbe Schnittstelle wie Vendos `ctx.datenbank` (bereit, abfrage,
// transaktion, beiBereit, migrieren), aber gegen die eigene Test-Datenbank und mit einem eigenen Schema je Testlauf.
// Nie gegen die echte Datenbank: Standard ist die Test-Datenbank aus Vendo (Container `vendo-test-db`, Port 55432),
// abweichend über VENDO_DB_URL (etwa der PostgreSQL-Dienst in GitHub Actions).
// Ist sie nicht erreichbar, gibt `testDatenbank()` null zurück, und die Tests werden übersprungen. Mit
// VENDO_DB_PFLICHT=1 (GitHub Actions) ist eine fehlende Datenbank dagegen ein Fehler.
//
// `migrieren` folgt Vendos src/main/datenbank.js: Version je Bereich in vendo.schema_version, unter Sperre, in einer
// Transaktion. Bereich ist hier das Testschema.

const URL = process.env.VENDO_DB_URL || 'postgres://postgres:nurtest@127.0.0.1:55432/vendo_test'

async function testDatenbank(name) {
  let Pool
  try {
    ;({ Pool } = require('pg'))
  } catch {
    return null
  }
  const schema = `nl_test_${name}_${process.pid}`.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40)
  const pool = new Pool({ connectionString: URL, max: 4, connectionTimeoutMillis: 3000 })
  pool.on('error', () => {})
  try {
    await pool.query('SELECT 1')
  } catch (f) {
    await pool.end().catch(() => {})
    if (process.env.VENDO_DB_PFLICHT) throw new Error(`Test-Datenbank nicht erreichbar: ${f.message}`)
    return null
  }
  let offen = true

  const bereit = () => offen
  const abfrage = (sql, werte) => {
    if (!offen) return Promise.reject(new Error('Datenbank nicht bereit: im Test abgeschaltet'))
    return pool.query(sql, werte)
  }
  async function transaktion(arbeit) {
    if (!offen) throw new Error('Datenbank nicht bereit: im Test abgeschaltet')
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      const erg = await arbeit(c)
      await c.query('COMMIT')
      return erg
    } catch (f) {
      await c.query('ROLLBACK').catch(() => {})
      throw f
    } finally {
      c.release()
    }
  }
  async function migrieren(liste) {
    const c = await pool.connect()
    try {
      await c.query('CREATE SCHEMA IF NOT EXISTS vendo')
      await c.query('CREATE TABLE IF NOT EXISTS vendo.schema_version (bereich text PRIMARY KEY, version int NOT NULL, geaendert_am timestamptz NOT NULL DEFAULT now())')
      await c.query('BEGIN')
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [schema])
      const r = await c.query('SELECT version FROM vendo.schema_version WHERE bereich = $1', [schema])
      const ist = r.rows[0]?.version || 0
      const offeneM = [...liste].sort((a, b) => a.version - b.version).filter((m) => m.version > ist)
      for (const m of offeneM) await c.query(m.sql)
      if (offeneM.length) await c.query('INSERT INTO vendo.schema_version (bereich, version) VALUES ($1, $2) ON CONFLICT (bereich) DO UPDATE SET version = $2, geaendert_am = now()', [schema, offeneM.at(-1).version])
      await c.query('COMMIT')
      return { vorher: ist, jetzt: offeneM.at(-1)?.version || ist }
    } catch (f) {
      await c.query('ROLLBACK').catch(() => {})
      throw f
    } finally {
      c.release()
    }
  }
  async function aufraeumen() {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await pool.query('DELETE FROM vendo.schema_version WHERE bereich = $1', [schema]).catch(() => {})
  }
  await aufraeumen()

  return {
    schema,
    datenbank: { bereit, abfrage, transaktion, beiBereit: (fn) => { if (offen) Promise.resolve().then(fn); return () => {} }, migrieren, zustand: () => ({ zustand: offen ? 'bereit' : 'aus' }) },
    // Ausfall nachstellen: danach scheitert jede Abfrage, bis `einschalten()`
    abschalten: () => { offen = false },
    einschalten: () => { offen = true },
    roh: (sql, werte) => pool.query(sql, werte),
    aufraeumen,
    async schliessen() {
      await aufraeumen().catch(() => {})
      await pool.end().catch(() => {})
    }
  }
}

module.exports = { testDatenbank, URL }
