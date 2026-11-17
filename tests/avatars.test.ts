import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

describe('portraits and agent icons', () => {
  let db: typeof import('../server/utils/db')
  let ops: typeof import('../server/operations')
  let actorModule: typeof import('../server/utils/actor')
  let ownerId = ''
  let memberId = ''
  let boardId = ''

  const actorOf = (id: string) => actorModule.actorFor(db.findUser(id)!)
  const statusOf = async (promise: Promise<unknown>) => {
    try {
      await promise
      return 200
    } catch (error) {
      return (error as { statusCode?: number }).statusCode ?? 500
    }
  }
  /** A photo the way a browser would send one after cropping: a data URL. */
  const photo = async (width: number, height: number, format: 'png' | 'jpeg' = 'png') => {
    const image = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } } })
    const buffer = await (format === 'png' ? image.png() : image.jpeg().withMetadata({ exif: { IFD0: { Copyright: 'secret place' } } })).toBuffer()
    return `data:image/${format};base64,${buffer.toString('base64')}`
  }

  beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-bugster-avatars-'))
    process.env.DATABASE_PATH = join(directory, 'open-bugster.sqlite')
    process.env.ATTACHMENTS_PATH = join(directory, 'attachments')
    process.env.BUGSTER_SECRET_KEY = randomBytes(32).toString('base64')
    process.env.APP_PASSWORD_HASH = 'scrypt$abc$def'
    process.env.APP_ADMIN_EMAIL = 'owner@example.com'
    process.env.APP_ADMIN_FIRST_NAME = 'Grace'
    process.env.APP_ADMIN_LAST_NAME = 'Hopper'

    db = await import('../server/utils/db')
    ops = await import('../server/operations')
    actorModule = await import('../server/utils/actor')
    ownerId = db.listUsers()[0]!.id
    memberId = db.createUser({ email: 'ada@example.com', firstName: 'Ada', lastName: 'L', role: 'member' }).id
    db.updateUser(memberId, { status: 'active' })
    boardId = db.listBoards()[0]!.id
    db.setBoardMember(boardId, memberId, 'editor')
  })

  it('stores an upload as a square JPEG without its metadata, and names it everywhere', async () => {
    const result = await ops.run(ops.profileSetAvatar, actorOf(memberId), { image: await photo(900, 600, 'jpeg') }) as { avatarUrl: string }
    expect(result.avatarUrl).toMatch(new RegExp(`^/api/avatars/${memberId}\\?v=`))

    const stored = db.getUserAvatar(memberId)!
    expect(stored.mime).toBe('image/jpeg')
    const meta = await sharp(stored.data).metadata()
    expect([meta.width, meta.height, meta.format]).toEqual([256, 256, 'jpeg'])
    expect(meta.exif).toBeUndefined()

    // The same address reaches every list that draws the person.
    expect(db.personById(memberId)?.avatarUrl).toBe(result.avatarUrl)
    expect(db.boardMembers(boardId).find(member => member.userId === memberId)?.avatarUrl).toBe(result.avatarUrl)
    expect(db.listUsers().find(user => user.id === memberId)?.avatarUrl).toBe(result.avatarUrl)
  })

  it('keeps the original, so the cut can be moved later without uploading again', async () => {
    // Left half red, right half blue: which side the cut lands on shows in its colour.
    const halves = await sharp({ create: { width: 3000, height: 1000, channels: 3, background: { r: 220, g: 0, b: 0 } } })
      .composite([{ input: { create: { width: 1500, height: 1000, channels: 3, background: { r: 0, g: 0, b: 220 } } }, left: 1500, top: 0 }])
      .jpeg().toBuffer()
    const colourOf = async () => {
      const { data } = await sharp(db.getUserAvatar(memberId)!.data).resize(1, 1).raw().toBuffer({ resolveWithObject: true })
      return data[0]! > data[2]! ? 'red' : 'blue'
    }

    const first = await ops.run(ops.profileSetAvatar, actorOf(memberId), { image: `data:image/jpeg;base64,${halves.toString('base64')}`, position: 0 }) as { position: number; originalUrl: string }
    expect(first).toMatchObject({ position: 0, originalUrl: expect.stringMatching(/^\/api\/profile\/avatar\/original\?v=/) })
    expect(await colourOf()).toBe('red')
    // Kept no larger than it needs to be, and still without its metadata.
    const kept = await sharp(db.getUserAvatarSource(memberId)!.original).metadata()
    expect([kept.width, kept.height, kept.exif]).toEqual([2048, 683, undefined])

    const moved = await ops.run(ops.profileSetAvatar, actorOf(memberId), { position: 1 }) as { position: number }
    expect(moved.position).toBe(1)
    expect(await colourOf()).toBe('blue')
    expect((await ops.run(ops.profileGetAvatar, actorOf(memberId), {}) as { position: number }).position).toBe(1)
  })

  it('cannot move the cut when there is no photo to move it on', async () => {
    await ops.run(ops.profileRemoveAvatar, actorOf(ownerId), {})
    expect(await statusOf(ops.run(ops.profileSetAvatar, actorOf(ownerId), { position: 0.3 }))).toBe(409)
    expect(await statusOf(ops.run(ops.profileSetAvatar, actorOf(ownerId), { position: 2 }))).toBe(422)
  })

  it('gives a new upload a new address, so a cached picture is never stale', async () => {
    const before = db.personById(memberId)!.avatarUrl
    await new Promise(resolve => setTimeout(resolve, 5))
    await ops.run(ops.profileSetAvatar, actorOf(memberId), { image: await photo(400, 400) })
    expect(db.personById(memberId)!.avatarUrl).not.toBe(before)
  })

  it('refuses what is not a picture', async () => {
    expect(await statusOf(ops.run(ops.profileSetAvatar, actorOf(memberId), { image: 'data:image/png;base64,bm90IGFuIGltYWdl' }))).toBe(422)
    expect(await statusOf(ops.run(ops.profileSetAvatar, actorOf(memberId), { image: 'data:image/svg+xml;base64,PHN2Zy8+' }))).toBe(422)
    expect(await statusOf(ops.run(ops.profileSetAvatar, actorOf(memberId), { image: 'https://example.com/me.png' }))).toBe(422)
  })

  it('removes a portrait, and anonymizing removes it too', async () => {
    await ops.run(ops.profileRemoveAvatar, actorOf(memberId), {})
    expect(db.personById(memberId)!.avatarUrl).toBeNull()

    await ops.run(ops.profileSetAvatar, actorOf(memberId), { image: await photo(300, 500) })
    await ops.run(ops.userAnonymize, actorOf(ownerId), { userId: memberId })
    expect(db.getUserAvatar(memberId)).toBeNull()
    expect(db.getUserAvatarSource(memberId)).toBeNull()
    expect(db.personById(memberId)!.avatarUrl).toBeNull()
  })

  it('lets an administrator give an agent one of the icons, and nothing else', async () => {
    const { service } = await ops.run(ops.serviceCreate, actorOf(ownerId), { name: 'Hermes', icon: 'rocket' }) as { service: { id: string; icon: string | null } }
    expect(service.icon).toBe('rocket')
    expect(db.personById(service.id)).toMatchObject({ isService: true, icon: 'rocket' })

    const { service: changed } = await ops.run(ops.serviceUpdate, actorOf(ownerId), { serviceId: service.id, icon: 'squirrel' }) as { service: { icon: string | null } }
    expect(changed.icon).toBe('squirrel')
    db.setBoardMember(boardId, service.id, 'editor')
    expect(db.boardMembers(boardId).find(member => member.userId === service.id)?.icon).toBe('squirrel')

    expect(await statusOf(ops.run(ops.serviceUpdate, actorOf(ownerId), { serviceId: service.id, icon: 'unicorn' }))).toBe(422)
    const { service: plain } = await ops.run(ops.serviceUpdate, actorOf(ownerId), { serviceId: service.id, icon: null }) as { service: { icon: string | null } }
    expect(plain.icon).toBeNull()
  })
})
