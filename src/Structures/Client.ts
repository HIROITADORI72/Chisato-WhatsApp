import chalk from 'chalk'
import { config as Config } from 'dotenv'
import EventEmitter from 'events'
import TypedEmitter from 'typed-emitter'
import makeWASocket, {
    DisconnectReason,
    fetchLatestBaileysVersion,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    proto,
    ParticipantAction
} from '@whiskeysockets/baileys'
import P from 'pino'
import { connect, set } from 'mongoose'
import { Boom } from '@hapi/boom'
import qr from 'qr-image'
import { Utils } from '../lib'
import { Database, Contact, Message, AuthenticationFromDatabase, Server } from '.'
import { IConfig, client, IEvent, ICall } from '../Types'

type Events = {
    new_call: (call: { from: string }) => void
    new_message: (M: Message) => void
    participants_update: (event: IEvent) => void
    new_group_joined: (group: { jid: string; subject: string }) => void
}

export class Client extends (EventEmitter as new () => TypedEmitter<Events>) {
    private client!: ReturnType<typeof makeWASocket>

    constructor() {
        super()
        Config()
        this.config = {
            name: process.env.BOT_NAME || 'Bot',
            session: process.env.SESSION || 'SESSION',
            prefix: process.env.PREFIX || ':',
            chatBotUrl: process.env.CHAT_BOT_URL || '',
            mods: (process.env.MODS || '').split(', ').map((user) => `${user}@s.whatsapp.net`),
            PORT: Number(process.env.PORT || 3000)
        }
        new Server(this)
    }

    public start = async (): Promise<typeof this.client> => {
        if (!process.env.MONGO_URI) throw new Error('No MongoDB URI provided')

        set('strictQuery', false)
        await connect(process.env.MONGO_URI)
        this.log('Connected to the Database')

        const { state, saveCreds, clear } = await useMultiFileAuthState(`./session/${this.config.session}`)
        const { version } = await fetchLatestBaileysVersion()

        this.client = makeWASocket({
            version,
            printQRInTerminal: true,
            browser: ['Chisato-WhatsApp', 'Desktop', '4.0.0'],
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' }))
            },
            logger: P({ level: 'fatal' }),
            getMessage: async (key) => ({ conversation: '' }),
            msgRetryCounterMap: {},
            markOnlineOnConnect: false
        })

        this.client.ev.on('creds.update', saveCreds)
        this.client.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr: qrString } = update

            if (qrString) {
                this.log(`QR generated. You can also auth in http://localhost:${this.config.PORT}`)
                this.QR = qr.imageSync(qrString)
            }

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut
                if (shouldReconnect) {
                    this.log('Reconnecting...')
                    setTimeout(() => this.start(), 3000)
                } else {
                    this.log('Session ended, clearing auth')
                    await clear()
                    setTimeout(() => this.start(), 3000)
                }
            } else if (connection === 'open') {
                this.condition = 'connected'
                this.log('Connected to WhatsApp')
            } else if (connection === 'connecting') {
                this.condition = 'connecting'
                this.log('Connecting to WhatsApp...')
            }
        })

        this.client.ev.on('messages.upsert', async ({ messages }) => {
            const M = new Message(messages[0], this)
            if (['protocolMessage', 'senderKeyDistributionMessage'].includes(M.type)) return

            if (M.stubType && M.stubParameters) {
                const emitParticipantsUpdate = (action: ParticipantAction) =>
                    this.emit('participants_update', {
                        jid: M.from,
                        participants: M.stubParameters as string[],
                        action
                    })

                switch (M.stubType) {
                    case proto.WebMessageInfo.StubType.GROUP_CREATE:
                        return void this.emit('new_group_joined', {
                            jid: M.from,
                            subject: M.stubParameters[0]
                        })
                    case proto.WebMessageInfo.StubType.GROUP_PARTICIPANT_ADD:
                    case proto.WebMessageInfo.StubType.GROUP_PARTICIPANT_ADD_REQUEST_JOIN:
                    case proto.WebMessageInfo.StubType.GROUP_PARTICIPANT_INVITE:
                        return void emitParticipantsUpdate('add')
                    case proto.WebMessageInfo.StubType.GROUP_PARTICIPANT_LEAVE:
                    case proto.WebMessageInfo.StubType.GROUP_PARTICIPANT_REMOVE:
                        return void emitParticipantsUpdate('remove')
                    case proto.WebMessageInfo.StubType.GROUP_PARTICIPANT_DEMOTE:
                        return void emitParticipantsUpdate('demote')
                    case proto.WebMessageInfo.StubType.GROUP_PARTICIPANT_PROMOTE:
                        return void emitParticipantsUpdate('promote')
                }
            }

            return void this.emit('new_message', await M.simplify())
        })

        this.client.ev.on('contacts.update', async (contacts) => await this.contact.saveContacts(contacts))
        this.client.ev.on('CB:call', (call: ICall) => this.emit('new_call', { from: call.content[0].attrs['call-creator'] }))

        return this.client
    }

    public utils = new Utils()
    public DB = new Database()
    public config: IConfig
    public contact = new Contact(this)
    public correctJid = (jid: string): string => `${jid.split('@')[0].split(':')[0]}@s.whatsapp.net`
    public assets = new Map<string, Buffer>()
    public log = (text: string, error = false): void => console.log(
        chalk[error ? 'red' : 'blue'](`[${this.config.name.toUpperCase()}]`),
        chalk[error ? 'redBright' : 'greenBright'](text)
    )
    public QR!: Buffer
    public condition!: 'connected' | 'connecting' | 'logged_out'
}
