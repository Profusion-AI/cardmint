import http from 'node:http'

export class MangleClient {
  constructor(baseUrl = process.env.MANGLE_BASE_URL || 'http://localhost:8089') {
    this.baseUrl = baseUrl
    this._open = true
    this._failures = 0
  }

  async loadFacts(batch) {
    await this._post('/facts:load', batch)
  }

  async query(req) {
    return this._post('/query', req)
  }

  async _post(path, body) {
    if (!this._open) throw new Error('circuit-open')
    try {
      return await this._postOnce(path, body)
    } catch (e) {
      this._failures++
      if (this._failures >= 3) this._open = false
      // one simple retry
      return await this._postOnce(path, body)
    }
  }

  _postOnce(path, body) {
    const url = new URL(this.baseUrl + path)
    const payload = Buffer.from(JSON.stringify(body))
    const opts = {
      method: 'POST',
      hostname: url.hostname,
      port: Number(url.port) || 80,
      path: url.pathname,
      headers: { 'content-type': 'application/json', 'content-length': payload.length }
    }
    return new Promise((resolve, reject) => {
      const req = http.request(opts, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if ((res.statusCode || 500) >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${text}`))
          resolve(text ? JSON.parse(text) : {})
        })
      })
      req.on('error', reject)
      req.write(payload)
      req.end()
    })
  }
}

