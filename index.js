'use strict'

// Also requires glob (npm/npm-packlist#42)
const packlist = require('npm-packlist')
const tar = require('tar-fs')
const dockerPull = require('docker-pull')
const dockerRun = require('docker-run')
const logger = require('log-update')
const bytes = require('pretty-bytes')
const browserify = require('browserify')
const unixify = require('unixify')
const once = require('once')
const path = require('path')

module.exports = function (opts, callback) {
  if (typeof opts === 'function') {
    callback = opts
    opts = null
  }

  opts = opts || {}
  callback = once(callback)

  const images = [].concat(opts.image || [])
  const cwd = path.resolve(opts.cwd || '.')
  const files = JSON.stringify(packageFiles(cwd))
  const prebuilds = path.join(cwd, 'prebuilds')
  const log = logger.create(process.stderr, { showCursor: true })

  loop()

  function loop () {
    let image = images.shift()
    if (!image) return process.nextTick(callback)
    if (!image.includes('/')) image = 'prebuild/' + image

    dockerPull(image)
      .on('progress', progress)
      .on('error', callback)
      .on('end', end)

    function progress () {
      const count = `${this.layers} layers`
      const ratio = `${bytes(this.transferred)} / ${bytes(this.length)}`

      log(`> prebuildify-cross pull ${this.image}: ${count}, ${ratio}`)
    }

    function end () {
      log.done()
      run(this.image)
    }
  }

  function run (image) {
    const argv = prebuildifyArgv(opts.argv || [], image)

    console.error('> prebuildify-cross run %s', image)
    console.error('> prebuildify %s\n', argv.join(' '))

    const child = dockerRun(image, {
      entrypoint: 'node',
      argv: ['-'].concat(argv),
      volumes: {
        // Should but can't use :ro (mafintosh/docker-run#12)
        [cygwin(cwd)]: '/input'
      },
      env: {
        PREBUILDIFY_CROSS_FILES: files,
        // Disable npm update check
        NO_UPDATE_NOTIFIER: 'true'
      }
    })

    child
      .on('error', callback)
      .on('exit', onexit)

    guestScript()
      .pipe(child.stdin)

    child.stderr
      .pipe(process.stderr)

    child.stdout
      .pipe(tar.extract(prebuilds), { dmode: 0o755, fmode: 0o644 })
      .on('finish', loop)
      .on('error', callback)
  }

  function onexit (code) {
    if (code) return callback(new Error('Exited with code ' + code))
  }
}

function packageFiles (dir) {
  return packlist.sync({ dir }).filter(function (fp) {
    return !/^prebuilds[/\\]/i.test(fp)
  })
}

function guestScript () {
  return browserify(require.resolve('./guest.js'), {
    basedir: __dirname,
    node: true
  }).bundle()
}

function prebuildifyArgv (argv, image) {
  argv = argv.slice()

  for (let i = 0; i < argv.length - 1; i++) {
    if (/^(-i|--image)$/.test(argv[i]) && argv[i + 1][0] !== '-') {
      argv.splice(i--, 2)
    }
  }

  // TODO: move this to the docker images?
  if (/^prebuild\/(linux|android)-arm/.test(image)) argv.push('--tag-armv')
  if (/^prebuild\/(centos|alpine)/.test(image)) argv.push('--tag-libc')

  return argv
}

function cygwin (fp) {
  if (process.platform !== 'win32') return fp
  if (!truthy(process.env.COMPOSE_CONVERT_WINDOWS_PATHS)) return fp

  const unix = unixify(fp)
  const drive = fp.match(/^([A-Z]):/i)

  return drive ? '/' + drive[1].toLowerCase() + unix : unix
}

function truthy (str) {
  return str === 'true' || str === '1'
}
