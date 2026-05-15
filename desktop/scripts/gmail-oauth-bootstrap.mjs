#!/usr/bin/env node
/**
 * One-shot helper to mint a Google OAuth refresh_token for the zspark
 * Gmail MCP server. Run this on your dev machine, paste the resulting
 * refresh_token into Settings → MCP servers (env: ZSPARK_GMAIL_REFRESH_TOKEN).
 *
 * Prereqs in your GCP project:
 *   - OAuth consent screen: External, your @gmail.com added as a Test user
 *   - Enabled APIs: Gmail API, Google Calendar API
 *   - OAuth client type: Desktop app  (gives you a client_id + client_secret)
 *
 * Usage:
 *   GMAIL_CLIENT_ID=xxx.apps.googleusercontent.com \
 *   GMAIL_CLIENT_SECRET=GOCSPX-xxx \
 *   node scripts/gmail-oauth-bootstrap.mjs
 *
 * It will print a URL — open it in a browser, sign in with the Test user
 * gmail, click Allow, and copy the resulting `code` from the redirected URL
 * back into the terminal. The script then exchanges it for a refresh_token
 * and prints the value.
 */

import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

const CLIENT_ID = process.env.GMAIL_CLIENT_ID
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET env vars first.')
  process.exit(1)
}

const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob' // OOB still works for Desktop clients
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events'
].join(' ')

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
authUrl.searchParams.set('client_id', CLIENT_ID)
authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
authUrl.searchParams.set('response_type', 'code')
authUrl.searchParams.set('scope', SCOPES)
authUrl.searchParams.set('access_type', 'offline')
authUrl.searchParams.set('prompt', 'consent')

console.log('\n1. Open this URL in your browser:\n')
console.log(authUrl.toString())
console.log('\n2. Sign in with the gmail you added as a Test user, click Allow.')
console.log('3. Google will show you a one-time code (or it will be in the redirected URL after `code=`).\n')

const rl = createInterface({ input: stdin, output: stdout })
const code = (await rl.question('Paste the code here: ')).trim()
rl.close()

const body = new URLSearchParams({
  code,
  client_id: CLIENT_ID,
  client_secret: CLIENT_SECRET,
  redirect_uri: REDIRECT_URI,
  grant_type: 'authorization_code'
})

const res = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body
})
const data = await res.json()
if (!res.ok) {
  console.error('Token exchange failed:', data)
  process.exit(1)
}
if (!data.refresh_token) {
  console.error('No refresh_token returned. Make sure you used prompt=consent and access_type=offline (the script does), and that your GCP OAuth client is type Desktop.')
  console.error(data)
  process.exit(1)
}

console.log('\n✅ Done. Paste these into zspark Settings → MCP servers → gmail → Env:\n')
console.log(`ZSPARK_GMAIL_CLIENT_ID=${CLIENT_ID}`)
console.log(`ZSPARK_GMAIL_CLIENT_SECRET=${CLIENT_SECRET}`)
console.log(`ZSPARK_GMAIL_REFRESH_TOKEN=${data.refresh_token}`)
console.log('# optional, used as the From: header on outgoing mail')
console.log('# ZSPARK_GMAIL_USER_EMAIL=you@gmail.com')
