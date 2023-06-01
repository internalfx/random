
// import config from './config/default.js'
import cors from '@koa/cors'
import Promise from 'bluebird'
import fsp from 'fs/promises'
import http from 'http'
import Koa from 'koa'
import ratelimit from 'koa-ratelimit'
import _ from 'lodash'
import path from 'node:path'
import { createRouter } from 'radix3'
import ejs from 'ejs'
import mime from 'mime-types'
import { DateTime } from 'luxon'
import dayjs from './services/dayjs.js'

const config = {}
const koa = new Koa()
const ratelimitDB = new Map()
let configured = false
let loaded = false
const substruct = {}
const trailingSlash = /^(.+)\/$/

substruct.router = createRouter()

const collapse = function (obj, depth, delimiter = `/`) {
  const output = {}
  depth = depth || []
  Object.keys(obj).forEach(function (key) {
    const val = obj[key]
    if (_.isFunction(val) || _.isString(val) || _.isArray(val) || _.isBoolean(val)) {
      Object.assign(output, { [depth.concat([key]).join(delimiter)]: val })
    } else if (_.isObject(val)) {
      Object.assign(output, collapse(val, depth.concat([key]), delimiter))
    }
  })
  return output
}

const importDirectory = async function (spec) {
  const { dir, filter } = spec
  const output = {}

  const scanDir = async function (dir, obj) {
    const list = await fsp.readdir(dir, { withFileTypes: true })

    let files = list.filter(function (item) {
      return item.isDirectory() === false
    })
    if (filter) {
      files = files.filter(function (item) {
        return item.name.match(filter)
      })
    }

    const dirs = list.filter(function (item) {
      return item.isDirectory()
    })

    await Promise.map(files, async function (item) {
      const name = _.last(item.name.match(filter))
      const info = path.parse(path.join(dir, item.name))
      if (info.ext === `.js`) {
        const module = await import(path.join(dir, item.name))
        obj[name] = module.default
      } else {
        // console.log(dir)
        const shortDir = dir.replace(`${config.appDir}/routes`, ``)
        obj[name] = shortDir + `/` + name + info.ext
        // console.log(obj[name])
      }
    })

    await Promise.map(dirs, async function (subDir) {
      obj[subDir.name] = {}
      await scanDir(path.join(dir, subDir.name), obj[subDir.name])
    })
  }

  await scanDir(dir, output)

  return output
}

const encodeJSON = function (data) {
  // return JSON.stringify(data).replace(/\\r/g, `\\\\u000D`).replace(/\\n/g, `\\\\u000A`)
  return encodeURI(JSON.stringify(data))
}

const renderEJS = async function (templatePath, locals, context) {
  return ejs.renderFile(path.join(config.appDir, `routes`, templatePath), locals, {
    async: true,
    cache: config.cacheTemplates === true,
    views: [
      path.join(config.appDir, `templates`),
    ],
    strict: true,
    context: {
      ...context,
      config,
      encodeJSON,
      path,
      DateTime,
      dayjs,
      _: _,
      get: _.get,
    },
  })
}

substruct.configure = async function (manualConfig = {}) {
  if (configured) {
    throw new Error(`Substruct has already been configured! You can only call substruct.configure() once before start()`)
  }

  const appDir = manualConfig.appDir || process.cwd()

  Object.assign(config, manualConfig)

  config.appDir = appDir
  config.confDir = path.join(appDir, `config`)
  config.routesDir = path.join(appDir, `routes`)

  koa.proxy = config.koa.proxy

  configured = true

  return config
}

substruct.load = async function () {
  if (configured !== true) {
    throw new Error(`Substruct has not been configured yet! Call substruct.configure() before load()`)
  }

  if (loaded) {
    throw new Error(`Substruct has already been loaded! You can only call substruct.load() once before start()`)
  }

  await substruct._loadMiddleware()
  await substruct._loadRoutes()

  loaded = true
}

substruct._loadMiddleware = async function () {
  koa.use(ratelimit({
    driver: `memory`,
    db: ratelimitDB,
    duration: 60000,
    errorMessage: `Too many requests`,
    id: (ctx) => ctx.ip,
    headers: {
      remaining: `Rate-Limit-Remaining`,
      reset: `Rate-Limit-Reset`,
      total: `Rate-Limit-Total`,
    },
    max: 600,
    disableHeader: false,
    whitelist: (ctx) => {
      // some logic that returns a boolean
    },
    blacklist: (ctx) => {
      // some logic that returns a boolean
    },
  }))
  koa.use(cors(config.koa.cors))

  const middleware = await importDirectory({
    dir: path.resolve(`middleware`),
    filter: /(.*)\.js$/,
  })

  for (const name of config.middleware) {
    if (middleware[name] == null) {
      throw new Error(`"${name}" middleware not found.`)
    }
    koa.use(await Promise.resolve(middleware[name](config)))
  }

  // ********
  // *       *
  // *        *
  // *       *
  // *    **
  // *****
  // *    *
  // *     *
  // *      *
  // *       *
  // *        *
  koa.use(async function (ctx, next) {
    // console.log(`START ROUTER`)
    ctx.state = {
      ...ctx.state,
    }

    const httpMethod = ctx.method.toLowerCase()
    const requestPath = ctx.path.replace(trailingSlash, `$1`)
    let content

    const route = substruct.router.lookup(requestPath)

    // console.log(route)

    if (route?.isRoute != null) {
      ctx.state.params = route?.params

      if (route.handlers[httpMethod]) {
        content = await route.handlers[httpMethod](ctx)
      }

      const template = route?.templates[httpMethod]

      if (template) {
        const html = await renderEJS(template, { content }, {
          ctx: {
            // ...ctx,
            headers: ctx.headers,
            state: ctx.state,
            query: ctx.query,
          },
        })

        ctx.body = html
      } else if (typeof content !== `undefined`) {
        if (_.isPlainObject(content)) {
          ctx.set(`Content-Type`, `application/json`)
        }
        ctx.body = content
      }
    } else {
      let err

      ctx.set(`Cache-Control`, `max-age=86400`)
      ctx.set(`Content-Type`, mime.lookup(requestPath))

      if (requestPath.match(/^\/(?:dist|static)\//)) {
        try {
          const readHandle = await fsp.open(path.join(config.appDir, requestPath))
          ctx.body = readHandle.createReadStream()
          err = undefined
        } catch (e) {
          err = e
        }
      } else {
        try {
          const readHandle = await fsp.open(path.join(config.appDir, `static`, requestPath))
          ctx.body = readHandle.createReadStream()
          err = undefined
        } catch (e) {
          err = e
        }
      }

      if (err?.code === `ENOENT`) {
        ctx.throw(404)
      } else if (err?.code === `EISDIR`) {
        ctx.throw(404)
      } else if (err != null) {
        ctx.throw(500, err)
      }
    }

    // console.log(`LEAVE ROUTER`)
    await next()
    // console.log(`RETURN ROUTER`)
  })
}

substruct._loadRoutes = async function () {
  const dataRouteList = collapse(await importDirectory({
    dir: config.routesDir,
    filter: /(.+)\.js$/,
  }))
  const viewRouteList = collapse(await importDirectory({
    dir: config.routesDir,
    filter: /(.+)\.ejs$/,
  }))

  const routes = []
  const httpMethods = [`get`, `post`, `put`, `patch`, `delete`, `options`]

  for (let [path, handler] of Object.entries(dataRouteList)) {
    const route = {
      handler: handler,
      methods: httpMethods,
    }

    path = `/${path}`.replace(/\bindex\b/g, ``)
    path = path.replace(/\[...\]/g, `**`)
    path = path.replace(/\[(.+?)\]/g, `:$1`)
    path = path.replace(trailingSlash, `$1`)

    const methodRegex = /\.(get|post|put|patch|delete|options)$/
    const methodSearch = path.match(methodRegex)

    if (methodSearch) {
      path = path.replace(methodRegex, ``)
      path = path.replace(trailingSlash, `$1`)
      route.methods = [methodSearch[1]]
    }

    route.path = path

    routes.push(route)
  }

  for (let [path, template] of Object.entries(viewRouteList)) {
    const route = {
      template: template,
      methods: httpMethods,
    }

    path = `/${path}`.replace(/\bindex\b/g, ``)
    path = path.replace(/\[...\]/g, `**`)
    path = path.replace(/\[(.+?)\]/g, `:$1`)
    path = path.replace(trailingSlash, `$1`)

    const methodRegex = /\.(get|post|put|patch|delete|options)$/
    const methodSearch = path.match(methodRegex)

    if (methodSearch) {
      path = path.replace(methodRegex, ``)
      path = path.replace(trailingSlash, `$1`)
      route.methods = [methodSearch[1]]
    }

    route.path = path

    routes.push(route)
  }

  routes.sort(function (a, b) {
    const segmentsA = a.path.split(`/`).length
    const segmentsB = b.path.split(`/`).length
    if (segmentsA > segmentsB) {
      return 1
    } else if (segmentsA < segmentsB) {
      return -1
    } else {
      if (a.methods.length > b.methods.length) {
        return 1
      } else if (a.methods.length < b.methods.length) {
        return -1
      } else {
        return 0
      }
    }
  })
  routes.reverse()

  const routeMap = {}

  for (const route of routes) {
    if (routeMap[route.path] == null) {
      routeMap[route.path] = {
        path: route.path,
        isRoute: true,
        handlers: {},
        templates: {},
      }
    }

    for (const method of route.methods) {
      if (route.handler) {
        routeMap[route.path].handlers[method] = route.handler
      }
      if (route.template) {
        routeMap[route.path].templates[method] = route.template
      }
    }
  }

  // console.log(routeMap)

  for (const [path, route] of Object.entries(routeMap)) {
    substruct.router.insert(path, route)
  }
}

substruct.start = async function () {
  if (configured !== true) {
    throw new Error(`Substruct has not been configured yet! Call substruct.configure() and substruct.load() before start()`)
  }

  if (loaded !== true) {
    throw new Error(`Substruct has not been loaded yet! Call substruct.load() before start()`)
  }

  console.log(`****************** SERVER START *****************`)
  console.log(`*  env = '${config.env}'`)
  console.log(`*  port = ${config.port}`)
  console.log(`*************************************************`)

  substruct.server = http.createServer(koa.callback())

  substruct.server.listen({
    port: config.port,
    host: config.host,
  })

  substruct.status = `running`

  return substruct
}

substruct.stop = async function () {
  console.log(`Stopping server...`)
  substruct.server.close()
  substruct.status = `stopped`
}

substruct.status = `stopped`
substruct.config = config
substruct.koa = koa
substruct.meta = {}

export { config }

export default substruct
