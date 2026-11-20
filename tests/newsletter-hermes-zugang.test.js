'use strict'
// Newsletter: Shopify-Zugang aus den Hermes-Einstellungen (zentral im System-Tab erneuert), wie im Buchhaltungs-Plugin.
// Nur ein erfundener Token in einem Temp-Ordner; die echten Hermes-Einstellungen werden nie gelesen.
//   node --test tests/newsletter-hermes-zugang.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const shopify = require('../shopify.js')

test('hermesZugang: Token und Shop aus Profil oder Hauptordner, sonst null', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vendo-hermes-'))
  const alt = { home: process.env.VENDO_TEST_HERMES_HOME, profil: process.env.VENDO_HERMES_PROFIL }
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true })
    for (const [k, v] of [['VENDO_TEST_HERMES_HOME', alt.home], ['VENDO_HERMES_PROFIL', alt.profil]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  })
  process.env.VENDO_TEST_HERMES_HOME = home
  process.env.VENDO_HERMES_PROFIL = 'beispielprofil'
  assert.equal(shopify.hermesZugang(), null)
  fs.writeFileSync(path.join(home, '.env'), 'SHOPIFY_STORE=https://beispiel-shop.myshopify.com/\n')
  assert.equal(shopify.hermesZugang(), null, 'ohne Token kein Zugang')
  fs.mkdirSync(path.join(home, 'profiles', 'beispielprofil'), { recursive: true })
  fs.writeFileSync(path.join(home, 'profiles', 'beispielprofil', 'config.yaml'), "  SHOPIFY_ACCESS_TOKEN: 'shpat_ERFUNDEN0123456789abcdef'\n")
  assert.deepEqual(shopify.hermesZugang(), { token: 'shpat_ERFUNDEN0123456789abcdef', shop: 'beispiel-shop.myshopify.com' })
})

test('hermesZugang: abweichendes Hermes-Profil über VENDO_HERMES_PROFIL', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vendo-hermes-'))
  const alt = { home: process.env.VENDO_TEST_HERMES_HOME, profil: process.env.VENDO_HERMES_PROFIL }
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true })
    for (const [k, v] of [['VENDO_TEST_HERMES_HOME', alt.home], ['VENDO_HERMES_PROFIL', alt.profil]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  })
  process.env.VENDO_TEST_HERMES_HOME = home
  process.env.VENDO_HERMES_PROFIL = 'testprofil'
  fs.mkdirSync(path.join(home, 'profiles', 'testprofil'), { recursive: true })
  fs.writeFileSync(path.join(home, 'profiles', 'testprofil', '.env'), 'SHOPIFY_ACCESS_TOKEN=shpat_ERFUNDENabcdef0123456789\nSHOPIFY_STORE=test-shop.myshopify.com\n')
  assert.deepEqual(shopify.hermesZugang(), { token: 'shpat_ERFUNDENabcdef0123456789', shop: 'test-shop.myshopify.com' })
})
