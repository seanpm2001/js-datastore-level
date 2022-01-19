import { Key } from 'interface-datastore'
import { BaseDatastore, Errors } from 'datastore-core'
import filter from 'it-filter'
import map from 'it-map'
import take from 'it-take'
import sort from 'it-sort'
// @ts-ignore no types
import Level from 'level'

/**
 * @typedef {import('interface-datastore').Datastore} Datastore
 * @typedef {import('interface-datastore').Pair} Pair
 * @typedef {import('interface-datastore').Batch} Batch
 * @typedef {import('interface-datastore').Query} Query
 * @typedef {import('interface-datastore').KeyQuery} KeyQuery
 * @typedef {import('interface-datastore').Options} QueryOptions
 */

/**
 * A datastore backed by leveldb.
 *
 * @implements {Datastore}
 */
export class LevelDatastore extends BaseDatastore {
  /**
   * @param {any} path
   * @param {Object} [opts]
   * @param {any} [opts.db] - level db reference
   * @param {boolean} [opts.createIfMissing]
   * @param {boolean} [opts.errorIfExists]
   * @param {string} [opts.prefix] - level-js option
   * @param {number} [opts.version] - level-js option
   * @param {number} [opts.cacheSize] - leveldown option
   * @param {number} [opts.writeBufferSize] - leveldown option
   * @param {number} [opts.blockSize] - leveldown option
   * @param {number} [opts.maxOpenFiles] - leveldown option
   * @param {number} [opts.blockRestartInterval] - leveldown option
   * @param {number} [opts.maxFileSize] - leveldown option
   */
  constructor (path, opts) {
    super()
    this.path = path
    this.opts = opts

    if (opts && opts.db) {
      this.database = opts.db
      delete opts.db
    } else {
      // @ts-ignore
      this.database = Level
    }
  }

  _initDb () {
    return new Promise((resolve, reject) => {
      this.db = this.database(
        this.path,
        {
          ...this.opts,
          valueEncoding: 'binary',
          compression: false // same default as go
        },
        /** @param {Error}  [err] */
        (err) => {
          if (err) {
            return reject(err)
          }
          resolve(this.db)
        }
      )
    })
  }

  async open () {
    try {
      if (this.db) {
        await this.db.open()
      } else {
        this.db = await this._initDb()
      }
    } catch (/** @type {any} */ err) {
      throw Errors.dbOpenFailedError(err)
    }
  }

  /**
   * @param {Key} key
   * @param {Uint8Array} value
   */
  async put (key, value) {
    try {
      await this.db.put(key.toString(), value)
    } catch (/** @type {any} */ err) {
      throw Errors.dbWriteFailedError(err)
    }
  }

  /**
   * @param {Key} key
   * @returns {Promise<Uint8Array>}
   */
  async get (key) {
    let data
    try {
      data = await this.db.get(key.toString())
    } catch (/** @type {any} */ err) {
      if (err.notFound) throw Errors.notFoundError(err)
      throw Errors.dbWriteFailedError(err)
    }
    return data
  }

  /**
   * @param {Key} key
   * @returns {Promise<boolean>}
   */
  async has (key) {
    try {
      await this.db.get(key.toString())
    } catch (/** @type {any} */ err) {
      if (err.notFound) return false
      throw err
    }
    return true
  }

  /**
   * @param {Key} key
   * @returns {Promise<void>}
   */
  async delete (key) {
    try {
      await this.db.del(key.toString())
    } catch (/** @type {any} */ err) {
      throw Errors.dbDeleteFailedError(err)
    }
  }

  close () {
    return this.db && this.db.close()
  }

  /**
   * @returns {Batch}
   */
  batch () {
    /** @type {{ type: string; key: string; value?: Uint8Array; }[]} */
    const ops = []
    return {
      put: (key, value) => {
        ops.push({
          type: 'put',
          key: key.toString(),
          value: value
        })
      },
      delete: (key) => {
        ops.push({
          type: 'del',
          key: key.toString()
        })
      },
      commit: () => {
        return this.db.batch(ops)
      }
    }
  }

  /**
   * @param {Query} q
   */
  query (q) {
    let it = this._query({
      values: true,
      prefix: q.prefix
    })

    if (Array.isArray(q.filters)) {
      it = q.filters.reduce((it, f) => filter(it, f), it)
    }

    if (Array.isArray(q.orders)) {
      it = q.orders.reduce((it, f) => sort(it, f), it)
    }

    const { offset, limit } = q
    if (offset) {
      let i = 0
      it = filter(it, () => i++ >= offset)
    }

    if (limit) {
      it = take(it, limit)
    }

    return it
  }

  /**
   * @param {KeyQuery} q
   */
  queryKeys (q) {
    let it = map(this._query({
      values: false,
      prefix: q.prefix
    }), ({ key }) => key)

    if (Array.isArray(q.filters)) {
      it = q.filters.reduce((it, f) => filter(it, f), it)
    }

    if (Array.isArray(q.orders)) {
      it = q.orders.reduce((it, f) => sort(it, f), it)
    }

    const { offset, limit } = q
    if (offset) {
      let i = 0
      it = filter(it, () => i++ >= offset)
    }

    if (limit) {
      it = take(it, limit)
    }

    return it
  }

  /**
   * @param {object} opts
   * @param {boolean} opts.values
   * @param {string} [opts.prefix]
   * @returns {AsyncIterable<Pair>}
   */
  _query (opts) {
    const iteratorOpts = {
      keys: true,
      keyAsBuffer: true,
      values: opts.values
    }

    // Let the db do the prefix matching
    if (opts.prefix != null) {
      const prefix = opts.prefix.toString()
      // Match keys greater than or equal to `prefix` and
      // @ts-ignore
      iteratorOpts.gte = prefix
      // less than `prefix` + \xFF (hex escape sequence)
      // @ts-ignore
      iteratorOpts.lt = prefix + '\xFF'
    }

    return levelIteratorToIterator(this.db.iterator(iteratorOpts))
  }
}

/**
 * @typedef {Object} LevelIterator
 * @property {(cb: (err: Error, key: string | Uint8Array | null, value: any)=> void)=>void} next
 * @property {(cb: (err: Error) => void) => void } end
 */

/**
 * @param {LevelIterator} li - Level iterator
 * @returns {AsyncIterable<Pair>}
 */
function levelIteratorToIterator (li) {
  return {
    [Symbol.asyncIterator] () {
      return {
        next: () => new Promise((resolve, reject) => {
          li.next((err, key, value) => {
            if (err) return reject(err)
            if (key == null) {
              return li.end(err => {
                if (err) return reject(err)
                resolve({ done: true, value: undefined })
              })
            }
            resolve({ done: false, value: { key: new Key(key, false), value } })
          })
        }),
        return: () => new Promise((resolve, reject) => {
          li.end(err => {
            if (err) return reject(err)
            resolve({ done: true, value: undefined })
          })
        })
      }
    }
  }
}
