'use strict'
const assert = require('node:assert')
const net = require('node:net')
const { PassThrough } = require('node:stream')
const { afterEach, beforeEach, describe, it } = require('node:test')

const { Address } = require('@haraka/email-address')
const { makeConnection, makePlugin } = require('haraka-test-fixtures')

const _set_up = (t, done) => {
  this.plugin = makePlugin('spamassassin', { register: false })
  this.plugin.cfg = {
    main: {
      spamc_auth_header: 'X-Haraka-Relaying123',
    },
    check: {},
  }

  this.connection = makeConnection({ withTxn: true })

  done()
}

describe('spamassassin', () => {
  beforeEach(_set_up)

  describe('register', () => {
    it('loads the spamassassin plugin', () => {
      assert.equal('spamassassin', this.plugin.name)
    })

    it('register loads spamassassin.ini', () => {
      this.plugin.register()
      assert.ok(this.plugin.cfg)
      assert.ok(this.plugin.cfg.main.spamd_socket)
    })
  })

  describe('load_spamassassin_ini', () => {
    beforeEach(_set_up)

    it('loads spamassassin.ini', () => {
      assert.equal(undefined, this.plugin.cfg.main.spamd_socket)
      this.plugin.load_spamassassin_ini()
      assert.ok(this.plugin.cfg.main.spamd_socket)
      assert.equal(this.plugin.cfg.main.spamc_auth_header, 'X-Haraka-Relay')
    })
  })

  describe('should_skip', () => {
    it('max_size not set', () => {
      assert.equal(false, this.plugin.should_skip(this.connection))
    })

    it('max_size 10, data_bytes 9 = false', () => {
      this.plugin.cfg.main = { max_size: 10 }
      this.connection.transaction.data_bytes = 9
      assert.equal(false, this.plugin.should_skip(this.connection))
    })

    it('max_size 10, data_bytes 11 = true', () => {
      this.plugin.cfg.main = { max_size: 10 }
      this.connection.transaction.data_bytes = 11
      assert.equal(true, this.plugin.should_skip(this.connection))
    })
  })

  describe('get_spamd_headers', () => {
    it('returns a spamd protocol request', () => {
      this.connection.transaction.mail_from = new Address('<matt@example.com>')
      this.connection.transaction.uuid = 'THIS-IS-A-TEST-UUID'
      const headers = this.plugin.get_spamd_headers(
        this.connection,
        'test_user',
      )
      const expected_headers = [
        'HEADERS SPAMC/1.4',
        'User: test_user',
        '',
        'X-Envelope-From: matt@example.com',
        'X-Haraka-UUID: THIS-IS-A-TEST-UUID',
      ]
      assert.deepEqual(headers, expected_headers)
    })
  })

  describe('get_spamd_headers_relaying', () => {
    beforeEach(_set_up)

    it('returns a spamd protocol request when relaying', () => {
      this.connection.transaction.mail_from = new Address('<matt@example.com>')
      this.connection.transaction.uuid = 'THIS-IS-A-TEST-UUID'
      this.connection.set('relaying', true)
      const headers = this.plugin.get_spamd_headers(
        this.connection,
        'test_user',
      )
      const expected_headers = [
        'HEADERS SPAMC/1.4',
        'User: test_user',
        '',
        'X-Envelope-From: matt@example.com',
        'X-Haraka-UUID: THIS-IS-A-TEST-UUID',
        'X-Haraka-Relaying123: true',
      ]
      assert.deepEqual(headers, expected_headers)
    })
  })

  describe('get_spamd_username', () => {
    beforeEach(_set_up)

    it('default', () => {
      assert.equal('default', this.plugin.get_spamd_username(this.connection))
    })

    it('set in txn.notes.spamd_user', () => {
      this.connection.transaction.notes.spamd_user = 'txuser'
      assert.equal('txuser', this.plugin.get_spamd_username(this.connection))
    })

    it('set in cfg.main.spamd_user', () => {
      this.plugin.cfg.main.spamd_user = 'cfguser'
      assert.equal('cfguser', this.plugin.get_spamd_username(this.connection))
    })

    it('set to first-recipient', () => {
      this.plugin.cfg.main.spamd_user = 'first-recipient'
      this.connection.transaction.rcpt_to = [new Address('<matt@example.com>')]
      assert.equal(
        'matt@example.com',
        this.plugin.get_spamd_username(this.connection),
      )
    })
  })

  describe('score_too_high', () => {
    beforeEach(_set_up)

    it('no threshhold is not too high', () => {
      assert.ok(!this.plugin.score_too_high(this.connection, { score: 5 }))
    })

    it('too high score is too high', () => {
      this.plugin.cfg.main.reject_threshold = 5
      assert.equal(
        'spam score exceeded threshold',
        this.plugin.score_too_high(this.connection, { score: 6 }),
      )
    })

    it('ok score with relaying is ok', () => {
      this.connection.relaying = true
      this.plugin.cfg.main.relay_reject_threshold = 7
      assert.equal(
        '',
        this.plugin.score_too_high(this.connection, { score: 6 }),
      )
    })

    it('too high score with relaying is too high', () => {
      this.connection.relaying = true
      this.plugin.cfg.main.relay_reject_threshold = 7
      assert.equal(
        'spam score exceeded relay threshold',
        this.plugin.score_too_high(this.connection, { score: 8 }),
      )
    })
  })

  // Regression for haraka/message-stream#22.
  describe('socket error cleanup', () => {
    let server

    beforeEach((t, done) => {
      this.plugin = makePlugin('spamassassin', { register: false })
      this.plugin.register()
      this.connection = makeConnection()
      this.connection.init_transaction()
      const txn = this.connection.transaction
      txn.mail_from = new Address('<m@example.com>')
      txn.rcpt_to = [new Address('<r@example.com>')]
      txn.uuid = 'TEST-UUID'
      txn.message_stream.add_line('Header: 1\r\n')
      txn.message_stream.add_line('\r\n')
      txn.message_stream.add_line('Body\r\n')
      txn.message_stream.add_line_end(done)
    })

    afterEach((t, done) => {
      if (server) server.close(done)
      else done()
    })

    it('hook_data_post unpipes message_stream when spamd drops the connection', (t, done) => {
      // Fake spamd that accepts then immediately destroys.
      server = net.createServer((s) => s.destroy())
      server.listen(0, '127.0.0.1', () => {
        this.plugin.cfg.main.spamd_socket = `127.0.0.1:${server.address().port}`
        this.plugin.cfg.defer = {}

        this.plugin.hook_data_post(() => {
          // After plugin returns, a second pipe must succeed — proves
          // message_stream is no longer "currently piping".
          const dest = new PassThrough()
          dest.resume()
          assert.doesNotThrow(
            () => this.connection.transaction.message_stream.pipe(dest),
            'message_stream must be free for re-pipe after socket error',
          )
          done()
        }, this.connection)
      })
    })

    it('next() is invoked only once even if error and close both fire', (t, done) => {
      server = net.createServer((s) => s.destroy())
      server.listen(0, '127.0.0.1', () => {
        this.plugin.cfg.main.spamd_socket = `127.0.0.1:${server.address().port}`
        this.plugin.cfg.defer = {}
        let calls = 0
        this.plugin.hook_data_post(() => {
          calls++
        }, this.connection)
        setTimeout(() => {
          assert.equal(calls, 1, `next() called ${calls} times, expected 1`)
          done()
        }, 100)
      })
    })
  })

  describe('get_spamd_username all-recipients', () => {
    beforeEach(_set_up)

    it('is unimplemented (throws)', () => {
      this.plugin.cfg.main.spamd_user = 'all-recipients'
      assert.throws(
        () => this.plugin.get_spamd_username(this.connection),
        /Unimplemented/,
      )
    })
  })

  describe('load_spamassassin_ini defaults', () => {
    beforeEach(_set_up)

    it('applies defaults and coerces numeric thresholds', () => {
      this.plugin.register()
      const m = this.plugin.cfg.main
      assert.equal(m.old_headers_action, 'rename')
      assert.equal(m.subject_prefix, '*** SPAM ***')
      assert.equal(m.max_size, 500000)
      assert.equal(typeof m.max_size, 'number')
    })
  })

  describe('should_skip branches', () => {
    beforeEach(_set_up)

    it('no transaction -> skip', () => {
      assert.equal(this.plugin.should_skip({}), true)
    })

    it('skips authenticated when check.authenticated=false', () => {
      this.plugin.cfg.check.authenticated = false
      this.connection.notes.auth_user = 'bob'
      assert.equal(this.plugin.should_skip(this.connection), true)
      assert.ok(
        this.connection.transaction.results.has(this.plugin, 'skip', 'authed'),
      )
    })

    it('skips relay when check.relay=false', () => {
      this.plugin.cfg.check.relay = false
      this.connection.relaying = true
      assert.equal(this.plugin.should_skip(this.connection), true)
      assert.ok(
        this.connection.transaction.results.has(this.plugin, 'skip', 'relay'),
      )
    })

    it('skips private_ip when check.private_ip=false', () => {
      this.plugin.cfg.check.private_ip = false
      this.connection.remote.is_private = true
      assert.equal(this.plugin.should_skip(this.connection), true)
      assert.ok(
        this.connection.transaction.results.has(
          this.plugin,
          'skip',
          'private_ip',
        ),
      )
    })
  })

  describe('header mutation', () => {
    beforeEach(_set_up)

    const saResponse = (over = {}) => ({
      flag: false,
      score: '1.0',
      reqd: '5.0',
      tests: 'NONE',
      headers: { Status: 'No, score=1.0 required=5.0', Flag: 'NO' },
      ...over,
    })

    it('fixup_old_headers: rename moves X-Spam-* to X-Old-*', () => {
      const txn = this.connection.transaction
      txn.add_header('X-Spam-Status', 'old value')
      txn.notes.spamassassin = saResponse()
      this.plugin.cfg = { main: { old_headers_action: 'rename' } }
      this.plugin.fixup_old_headers(txn)
      assert.equal(txn.header.get('X-Spam-Status'), '')
      assert.match(txn.header.get('X-Old-Spam-Status'), /old value/)
    })

    it('fixup_old_headers: drop removes X-Spam-* headers', () => {
      const txn = this.connection.transaction
      txn.add_header('X-Spam-Status', 'gone')
      txn.notes.spamassassin = saResponse()
      this.plugin.cfg = { main: { old_headers_action: 'drop' } }
      this.plugin.fixup_old_headers(txn)
      assert.equal(txn.header.get('X-Spam-Status'), '')
    })

    it('fixup_old_headers: keep leaves headers untouched', () => {
      const txn = this.connection.transaction
      txn.add_header('X-Spam-Status', 'kept')
      txn.notes.spamassassin = saResponse()
      this.plugin.cfg = { main: { old_headers_action: 'keep' } }
      this.plugin.fixup_old_headers(txn)
      assert.match(txn.header.get('X-Spam-Status'), /kept/)
    })

    it('do_header_updates: adds Precedence junk when flagged', () => {
      this.plugin.cfg = { main: { add_headers: false } }
      this.plugin.do_header_updates(this.connection, saResponse({ flag: true }))
      assert.match(this.connection.transaction.header.get('Precedence'), /junk/)
    })

    it('do_header_updates: legacy Status rewrites score= to hits=', () => {
      this.plugin.cfg = { main: { add_headers: true } }
      this.plugin.do_header_updates(
        this.connection,
        saResponse({ headers: { Status: 'No, score=1.0 required=5.0' } }),
      )
      assert.match(
        this.connection.transaction.header.get('X-Spam-Status'),
        /hits=1\.0/,
      )
    })

    it('munge_subject: prefixes when score exceeds threshold', () => {
      const txn = this.connection.transaction
      txn.add_header('Subject', 'hello there')
      this.plugin.cfg = {
        main: { munge_subject_threshold: 5, subject_prefix: '*** SPAM ***' },
      }
      this.plugin.munge_subject(this.connection, 6)
      assert.equal(txn.header.get('Subject'), '*** SPAM *** hello there')
    })

    it('munge_subject: no double-munge', () => {
      const txn = this.connection.transaction
      txn.add_header('Subject', '*** SPAM *** hello')
      this.plugin.cfg = {
        main: { munge_subject_threshold: 5, subject_prefix: '*** SPAM ***' },
      }
      this.plugin.munge_subject(this.connection, 9)
      assert.equal(txn.header.get('Subject'), '*** SPAM *** hello')
    })

    it('munge_subject: below threshold leaves subject', () => {
      const txn = this.connection.transaction
      txn.add_header('Subject', 'innocent')
      this.plugin.cfg = { main: { munge_subject_threshold: 5 } }
      this.plugin.munge_subject(this.connection, 1)
      assert.equal(txn.header.get('Subject'), 'innocent')
    })

    it('log_results records score/required/tests', () => {
      this.plugin.cfg = { main: { reject_threshold: 5 } }
      this.plugin.log_results(
        this.connection,
        saResponse({
          flag: true,
          score: '8.5',
          reqd: '5.0',
          tests: 'BAYES_99',
        }),
      )
      const r = this.connection.transaction.results.get(this.plugin)
      assert.equal(r.score, 8.5)
      assert.equal(r.required, 5)
      assert.equal(r.tests, 'BAYES_99')
    })
  })

  describe('hook_data_post (full spamd exchange)', () => {
    let server

    const startSpamd = (payload, cb) => {
      server = net.createServer((s) => {
        s.on('data', () => {})
        s.on('end', () => s.end(payload))
      })
      server.listen(0, '127.0.0.1', () => cb(server.address().port))
    }

    const primeTxn = (done) => {
      this.plugin = makePlugin('spamassassin', { register: false })
      this.plugin.register()
      this.connection = makeConnection()
      this.connection.init_transaction()
      const txn = this.connection.transaction
      txn.mail_from = new Address('<m@example.com>')
      txn.rcpt_to = [new Address('<r@example.com>')]
      txn.uuid = 'TEST-UUID'
      txn.add_header('Subject', 'cheap pills')
      txn.message_stream.add_line('Subject: cheap pills\r\n')
      txn.message_stream.add_line('\r\n')
      txn.message_stream.add_line('buy now\r\n')
      txn.message_stream.add_line_end(done)
    }

    afterEach((t, done) => {
      if (server) return server.close(done)
      done()
    })

    it('parses a spam verdict and DENYs over threshold', (t, done) => {
      primeTxn(() => {
        const resp =
          'SPAMD/1.1 0 EX_OK\r\n' +
          'Spam: True ; 12.3 / 5.0\r\n' +
          '\r\n' +
          'X-Spam-Status: Yes, score=12.3 required=5.0 ' +
          'tests=BAYES_99,HTML_MESSAGE autolearn=no\r\n' +
          'X-Spam-Flag: YES\r\n'
        startSpamd(resp, (port) => {
          this.plugin.cfg.main.spamd_socket = `127.0.0.1:${port}`
          this.plugin.cfg.main.reject_threshold = 5
          this.plugin.cfg.defer = {}
          this.plugin.hook_data_post((code) => {
            assert.equal(code, DENY)
            const sa = this.connection.transaction.notes.spamassassin
            assert.equal(sa.flag, true)
            assert.equal(sa.score, '12.3')
            assert.equal(sa.tests, 'BAYES_99,HTML_MESSAGE')
            done()
          }, this.connection)
        })
      })
    })

    it('passes a clean message under threshold', (t, done) => {
      primeTxn(() => {
        const resp =
          'SPAMD/1.1 0 EX_OK\r\n' +
          'Spam: False ; 0.1 / 5.0\r\n' +
          '\r\n' +
          'X-Spam-Status: No, score=0.1 required=5.0\r\n'
        startSpamd(resp, (port) => {
          this.plugin.cfg.main.spamd_socket = `127.0.0.1:${port}`
          this.plugin.cfg.main.reject_threshold = 5
          this.plugin.cfg.defer = {}
          this.plugin.hook_data_post((code) => {
            assert.equal(code, undefined)
            assert.equal(
              this.connection.transaction.notes.spamassassin.flag,
              false,
            )
            done()
          }, this.connection)
        })
      })
    })
  })
})
