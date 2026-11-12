import { spawnSync } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const bucket = 'meeting-files'
const batchSize = 25
const requestTimeoutMs = 15_000
const lockConflictExitCode = 75
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const lockDirectory = new URL('../node_modules/', import.meta.url)

function isMissingObject(error) {
  return error?.code === 'NoSuchKey' || (
    error?.code === undefined &&
    error?.message === 'Object not found' &&
    (error.status === 404 || String(error.statusCode) === '404')
  )
}

async function cleanup(supabase) {
  const storage = supabase.storage.from(bucket)
  let afterFileId = null
  let finalized = 0
  let failed = 0
  let claimFailed = false

  for (;;) {
    const { data: files, error } = await supabase.rpc('claim_expired_meeting_files', {
      p_limit: batchSize,
      p_after_file_id: afterFileId,
    })

    if (error || !Array.isArray(files) || files.length > batchSize) {
      console.error('[cleanup] claim failed')
      claimFailed = true
      break
    }

    if (files.length === 0) break

    let previousId = afterFileId
    for (const file of files) {
      if (!uuid.test(file?.file_id ?? '') ||
          (previousId !== null && file.file_id <= previousId)) {
        claimFailed = true
        break
      }
      previousId = file.file_id
    }

    if (claimFailed) {
      console.error('[cleanup] invalid claim order or file ID')
      break
    }

    afterFileId = previousId

    for (const { file_id: fileId, storage_path: path } of files) {
      let step = 'validate-path'
      try {
        const parts = typeof path === 'string' ? path.split('/') : []
        if (parts.length !== 2 || !uuid.test(parts[0]) || parts[1] !== fileId) {
          throw new Error('Invalid Storage path')
        }

        step = 'remove'
        const { data: removed, error: removeError } = await storage.remove([path])

        if (removeError) {
          if (!isMissingObject(removeError)) throw removeError
        } else if (Array.isArray(removed) && removed.length === 0) {
          step = 'verify-absence'
          const { error: infoError } = await storage.info(path)
          if (!isMissingObject(infoError)) {
            throw new Error('Storage did not confirm absence')
          }
        } else if (!Array.isArray(removed) ||
                   removed.length !== 1 ||
                   removed[0]?.name !== path) {
          throw new Error('Unexpected Storage response')
        }

        step = 'finalize'
        const { data: deleted, error: finalizeError } = await supabase.rpc(
          'finalize_meeting_file_cleanup',
          { p_file_id: fileId },
        )
        if (finalizeError || deleted !== true) {
          throw new Error('Finalization did not remove the row')
        }

        finalized += 1
      } catch {
        failed += 1
        console.error(`[cleanup] file=${fileId} failed at ${step}`)
      }
    }
  }

  console.log(`[cleanup] finalized=${finalized} failed=${failed} claim_failed=${claimFailed}`)
  return failed > 0 || claimFailed ? 1 : 0
}

async function main() {
  const url = process.env.SUPABASE_URL?.trim()
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()

  if (!url || !key) {
    console.error('[cleanup] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
    return 2
  }

  let endpoint
  try {
    endpoint = new URL(url)
  } catch {
    console.error('[cleanup] invalid SUPABASE_URL')
    return 2
  }

  const localHttp = endpoint.protocol === 'http:' &&
    ['host.docker.internal', 'localhost', '127.0.0.1'].includes(endpoint.hostname)

  if ((endpoint.protocol !== 'https:' && !localHttp) ||
      endpoint.username || endpoint.password ||
      endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    console.error('[cleanup] expected a Supabase API origin')
    return 2
  }

  let lockFd
  try {
    lockFd = openSync(lockDirectory, 'r')
    const lock = spawnSync(
      '/usr/bin/flock',
      ['--exclusive', '--nonblock', '--conflict-exit-code', String(lockConflictExitCode), '3'],
      { stdio: ['ignore', 'ignore', 'ignore', lockFd], env: {} },
    )

    if (lock.status === lockConflictExitCode) {
      console.error('[cleanup] another cleanup process is running')
      return lockConflictExitCode
    }

    if (lock.error || lock.status !== 0) {
      console.error('[cleanup] could not acquire the Docker volume lock')
      return 1
    }

    const supabase = createClient(endpoint.origin, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: {
        fetch: (input, init) => {
          const timeout = AbortSignal.timeout(requestTimeoutMs)
          return fetch(input, {
            ...init,
            redirect: 'error',
            signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
          })
        },
      },
    })

    return await cleanup(supabase)
  } catch {
    console.error('[cleanup] could not start or complete cleanup')
    return 1
  } finally {
    if (lockFd !== undefined) closeSync(lockFd)
  }
}

process.exitCode = await main()
