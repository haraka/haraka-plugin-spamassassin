'use strict'
const assert = require('node:assert')
const net = require('node:net')
const { PassThrough } = require('node:stream')
const { afterEach, beforeEach, describe, it } = require('node:test')

const Address = require('address-rfc2821')
const fixtures = require('haraka-test-fixtures')

const _set_up = (t, done) => {
  this.plugin = new fixtures.plugin('spamassassin')
  this.plugin.cfg = {
    main: {
      spamc_auth_header: 'X-Haraka-Relaying123',
    },
    check: {},
  }

  this.connection = fixtures.connection.createConnection()
  this.connection.init_transaction()

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
      this.connection.transaction.mail_from = new Address.Address(
        '<matt@example.com>',
      )
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
      this.connection.transaction.mail_from = new Address.Address(
        '<matt@example.com>',
      )
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
      this.connection.transaction.rcpt_to = [
        new Address.Address('<matt@example.com>'),
      ]
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
      this.plugin = new fixtures.plugin('spamassassin')
      this.plugin.register()
      this.connection = fixtures.connection.createConnection()
      this.connection.init_transaction()
      const txn = this.connection.transaction
      txn.mail_from = new Address.Address('<m@example.com>')
      txn.rcpt_to = [new Address.Address('<r@example.com>')]
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
})
