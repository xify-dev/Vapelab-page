require('dotenv').config();

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createHash, randomBytes, scrypt: scryptCallback, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const { Client, Events, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');

const scrypt = promisify(scryptCallback);
const root = __dirname;
const dataDirectory = process.env.DATA_DIRECTORY ? path.resolve(process.env.DATA_DIRECTORY) : path.join(root, 'data');
const ordersFile = path.join(dataDirectory, 'orders.json');
const accountsFile = path.join(dataDirectory, 'accounts.json');
const port = Number(process.env.PORT) || 3000;
const maxRequestBytes = 16 * 1024;
const sessionMaxAgeSeconds = 60 * 60 * 24 * 7;
const requestBuckets = new Map();
const sessions = new Map();
const paymentMethods = ['BLIK', 'Przelew bankowy', 'Pobranie'];

const catalog = {
    'Liquid Vapen 10ml': { price: 17.99, variants: ['Watermelon Ice', 'Blueberry Pomegranate', 'Kiwi Passion Fruit'] },
    'Fumot Digital Box 25k': { price: 55.99, variants: ['Blue Razz Cherry', 'Strawberry Watermelon', 'Juicy Peach Ice'] },
    'Merrymi Liquid 30ml': { price: 49.00, variants: ['Mamba Black', 'Bubblegum Burst', 'Sweet Candy'] },
    'WGA Crystal Liquid 10ml': { price: 18.89, variants: ['Lemon Lime', 'Cherry Ice', 'Gummy Bear'] },
    'Bang King 100k': { price: 79.99, variants: ['Strawberry Mango', 'Watermelon Ice', 'Love 66'] },
    'WGA Crystal 35k': { price: 60.00, variants: ['Pineapple Coconut', 'Hubba Bubba', 'Fizzy Cherry'] }
};

fs.mkdirSync(dataDirectory, { recursive: true });
let orders = new Map();
if (fs.existsSync(ordersFile)) {
    try {
        const savedOrders = JSON.parse(fs.readFileSync(ordersFile, 'utf8'));
        orders = new Map(savedOrders.map(order => [order.code, order]));
    } catch (error) {
        console.error('Nie można odczytać data/orders.json:', error.message);
        process.exit(1);
    }
}

let accounts = new Map();
if (fs.existsSync(accountsFile)) {
    try {
        const savedAccounts = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
        accounts = new Map(savedAccounts.map(account => [account.email, account]));
    } catch (error) {
        console.error('Nie można odczytać data/accounts.json:', error.message);
        process.exit(1);
    }
}

function saveOrders() {
    const temporaryFile = `${ordersFile}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify([...orders.values()], null, 2));
    fs.renameSync(temporaryFile, ordersFile);
}

function saveAccounts() {
    const temporaryFile = `${accountsFile}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify([...accounts.values()], null, 2));
    fs.renameSync(temporaryFile, accountsFile);
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
    response.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...extraHeaders
    });
    response.end(JSON.stringify(payload));
}

function publicAccount(account) {
    return { id: account.id, name: account.name, email: account.email, createdAt: account.createdAt };
}

function getCookieValue(request, name) {
    const prefix = `${name}=`;
    const cookie = (request.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(prefix));
    return cookie ? cookie.slice(prefix.length) : '';
}

function getSessionAccount(request) {
    const token = getCookieValue(request, 'vapelab_session');
    if (!token) return null;

    const sessionKey = createHash('sha256').update(token).digest('hex');
    const session = sessions.get(sessionKey);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
        sessions.delete(sessionKey);
        return null;
    }

    return [...accounts.values()].find(account => account.id === session.accountId) || null;
}

function setSessionCookie(request, token, maxAge) {
    const forwardedProto = (request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const secure = request.socket.encrypted || forwardedProto === 'https';
    return `vapelab_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function createSession(account) {
    const token = randomBytes(32).toString('base64url');
    const sessionKey = createHash('sha256').update(token).digest('hex');
    sessions.set(sessionKey, { accountId: account.id, expiresAt: Date.now() + sessionMaxAgeSeconds * 1000 });
    return token;
}

function readJsonBody(request) {
    return new Promise((resolve, reject) => {
        let body = '';
        request.on('data', chunk => {
            body += chunk;
            if (Buffer.byteLength(body) > maxRequestBytes) {
                reject(new Error('Żądanie jest za duże.'));
                request.destroy();
            }
        });
        request.on('end', () => {
            try {
                resolve(JSON.parse(body));
            } catch (error) {
                reject(new Error('Nieprawidłowy format danych.'));
            }
        });
        request.on('error', reject);
    });
}

function isRateLimited(request) {
    const address = request.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const bucket = requestBuckets.get(address);
    if (!bucket || now - bucket.startedAt >= 60_000) {
        requestBuckets.set(address, { startedAt: now, count: 1 });
        return false;
    }
    bucket.count += 1;
    return bucket.count > 10;
}

async function registerAccount(request, response) {
    if (isRateLimited(request)) {
        sendJson(response, 429, { error: 'Zbyt wiele prób. Spróbuj ponownie za chwilę.' });
        return;
    }

    let body;
    try {
        body = await readJsonBody(request);
    } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(response, 400, { error: 'Podaj prawidłowe dane konta.' });
        return;
    }

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (name.length < 2 || name.length > 60 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
        sendJson(response, 400, { error: 'Podaj prawidłowe imię i adres e-mail.' });
        return;
    }
    if (password.length < 10 || password.length > 128) {
        sendJson(response, 400, { error: 'Hasło musi mieć od 10 do 128 znaków.' });
        return;
    }
    if (body.adultConfirmed !== true) {
        sendJson(response, 400, { error: 'Potwierdź, że masz ukończone 18 lat.' });
        return;
    }
    if (accounts.has(email)) {
        sendJson(response, 409, { error: 'Konto z tym adresem e-mail już istnieje.' });
        return;
    }

    const salt = randomBytes(16).toString('hex');
    const passwordHash = (await scrypt(password, Buffer.from(salt, 'hex'), 64)).toString('hex');
    const account = {
        id: randomBytes(16).toString('hex'),
        name,
        email,
        salt,
        passwordHash,
        adultConfirmedAt: new Date().toISOString(),
        createdAt: new Date().toISOString()
    };
    accounts.set(email, account);
    try {
        saveAccounts();
    } catch (error) {
        accounts.delete(email);
        console.error('Nie można zapisać konta:', error);
        sendJson(response, 500, { error: 'Nie udało się utworzyć konta.' });
        return;
    }

    const token = createSession(account);
    sendJson(response, 201, { account: publicAccount(account) }, {
        'Set-Cookie': setSessionCookie(request, token, sessionMaxAgeSeconds)
    });
}

async function loginAccount(request, response) {
    if (isRateLimited(request)) {
        sendJson(response, 429, { error: 'Zbyt wiele prób. Spróbuj ponownie za chwilę.' });
        return;
    }

    let body;
    try {
        body = await readJsonBody(request);
    } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
    }

    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!email || password.length < 1 || password.length > 128) {
        sendJson(response, 400, { error: 'Podaj adres e-mail i hasło.' });
        return;
    }

    const account = accounts.get(email);
    const salt = Buffer.from(account?.salt || '00000000000000000000000000000000', 'hex');
    const actualHash = await scrypt(password, salt, 64);
    const expectedHash = Buffer.from(account?.passwordHash || '0'.repeat(128), 'hex');
    if (!timingSafeEqual(actualHash, expectedHash) || !account) {
        sendJson(response, 401, { error: 'Nieprawidłowy adres e-mail lub hasło.' });
        return;
    }

    const token = createSession(account);
    sendJson(response, 200, { account: publicAccount(account) }, {
        'Set-Cookie': setSessionCookie(request, token, sessionMaxAgeSeconds)
    });
}

function logoutAccount(request, response) {
    const token = getCookieValue(request, 'vapelab_session');
    if (token) sessions.delete(createHash('sha256').update(token).digest('hex'));
    sendJson(response, 200, { ok: true }, { 'Set-Cookie': setSessionCookie(request, '', 0) });
}

async function createOrder(request, response) {
    if (isRateLimited(request)) {
        sendJson(response, 429, { error: 'Zbyt wiele prób. Spróbuj ponownie za chwilę.' });
        return;
    }

    let body;
    try {
        body = await readJsonBody(request);
    } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
    }

    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 50) {
        sendJson(response, 400, { error: 'Koszyk musi zawierać od 1 do 50 produktów.' });
        return;
    }
    if (typeof body.phone !== 'string' || !/^[0-9+ ()-]{7,20}$/.test(body.phone.trim())) {
        sendJson(response, 400, { error: 'Podaj prawidłowy numer telefonu.' });
        return;
    }
    if (typeof body.parcelLocker !== 'string' || !/^[A-Z0-9-]{3,20}$/i.test(body.parcelLocker.trim())) {
        sendJson(response, 400, { error: 'Podaj prawidłowy numer paczkomatu.' });
        return;
    }
    if (!paymentMethods.includes(body.paymentMethod)) {
        sendJson(response, 400, { error: 'Wybrano nieprawidłową metodę płatności.' });
        return;
    }

    const items = [];
    for (const requestedItem of body.items) {
        const product = catalog[requestedItem?.name];
        if (!product || !product.variants.includes(requestedItem.variant)) {
            sendJson(response, 400, { error: 'Koszyk zawiera nieprawidłowy produkt lub wariant.' });
            return;
        }
        items.push({ name: requestedItem.name, variant: requestedItem.variant, price: product.price });
    }

    const total = Math.round(items.reduce((sum, item) => sum + item.price, 0) * 100) / 100;
    let code;
    do {
        code = `VL-${randomBytes(10).toString('hex').toUpperCase()}`;
    } while (orders.has(code));

    const order = {
        code,
        items,
        total,
        shipping: total >= 100 ? 'Darmowa' : 'Standardowa',
        phone: body.phone.trim(),
        parcelLocker: body.parcelLocker.trim().toUpperCase(),
        paymentMethod: body.paymentMethod,
        accountId: getSessionAccount(request)?.id || null,
        createdAt: new Date().toISOString()
    };
    orders.set(code, order);
    try {
        saveOrders();
    } catch (error) {
        orders.delete(code);
        console.error('Nie można zapisać zamówienia:', error);
        sendJson(response, 500, { error: 'Nie udało się zapisać zamówienia.' });
        return;
    }

    sendJson(response, 201, { code, total });
}

function serveFile(request, response, pathname) {
    let relativePath;
    try {
        relativePath = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
    } catch (error) {
        response.writeHead(400);
        response.end('Bad request');
        return;
    }

    const filePath = path.resolve(root, relativePath);
    const indexPath = path.join(root, 'index.html');
    const imagesDirectory = path.join(root, 'images');
    if (filePath !== indexPath && !filePath.startsWith(`${imagesDirectory}${path.sep}`)) {
        response.writeHead(404);
        response.end('Not found');
        return;
    }

    fs.readFile(filePath, (error, content) => {
        if (error) {
            response.writeHead(error.code === 'ENOENT' ? 404 : 500);
            response.end('Not found');
            return;
        }
        const contentTypes = {
            '.html': 'text/html; charset=utf-8',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.webp': 'image/webp',
            '.avif': 'image/avif',
            '.svg': 'image/svg+xml'
        };
        const contentType = contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
        response.writeHead(200, {
            'Content-Type': contentType,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': relativePath === 'index.html' ? 'no-cache' : 'public, max-age=86400'
        });
        response.end(content);
    });
}

const server = http.createServer((request, response) => {
    if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
    }
    let pathname;
    try {
        pathname = new URL(request.url, 'http://localhost').pathname;
    } catch (error) {
        sendJson(response, 400, { error: 'Nieprawidłowy adres żądania.' });
        return;
    }

    if (request.method === 'GET' && pathname === '/api/account/me') {
        const account = getSessionAccount(request);
        sendJson(response, 200, { account: account ? publicAccount(account) : null });
        return;
    }
    if (request.method === 'GET' && pathname === '/api/account/orders') {
        const account = getSessionAccount(request);
        if (!account) {
            sendJson(response, 401, { error: 'Zaloguj się, aby zobaczyć swoje zamówienia.' });
            return;
        }
        const accountOrders = [...orders.values()]
            .filter(order => order.accountId === account.id)
            .sort((first, second) => second.createdAt.localeCompare(first.createdAt))
            .map(({ code, items, total, shipping, createdAt }) => ({ code, items, total, shipping, createdAt }));
        sendJson(response, 200, { orders: accountOrders });
        return;
    }
    if (request.method === 'POST' && pathname === '/api/account/register') {
        registerAccount(request, response).catch(error => {
            console.error('Błąd rejestracji:', error);
            if (!response.headersSent) sendJson(response, 500, { error: 'Wystąpił błąd serwera.' });
        });
        return;
    }
    if (request.method === 'POST' && pathname === '/api/account/login') {
        loginAccount(request, response).catch(error => {
            console.error('Błąd logowania:', error);
            if (!response.headersSent) sendJson(response, 500, { error: 'Wystąpił błąd serwera.' });
        });
        return;
    }
    if (request.method === 'POST' && pathname === '/api/account/logout') {
        logoutAccount(request, response);
        return;
    }
    if (request.method === 'POST' && pathname === '/api/orders') {
        createOrder(request, response).catch(error => {
            console.error('Błąd API zamówień:', error);
            if (!response.headersSent) sendJson(response, 500, { error: 'Wystąpił błąd serwera.' });
        });
        return;
    }
    if (request.method === 'GET' && pathname.startsWith('/api/orders/')) {
        const code = decodeURIComponent(pathname.slice('/api/orders/'.length)).trim().toUpperCase();
        const order = orders.get(code);
        if (!order) {
            sendJson(response, 404, { error: 'Nie znaleziono zamówienia.' });
            return;
        }
        sendJson(response, 200, order);
        return;
    }
    if (request.method === 'GET' && !pathname.startsWith('/api/')) {
        serveFile(request, response, pathname);
        return;
    }
    sendJson(response, 404, { error: 'Nie znaleziono zasobu.' });
});

server.listen(port, () => console.log(`VapeLab działa: http://localhost:${port}`));

async function startDiscordBot() {
    if (process.env.DISCORD_BOT_DISABLED === 'true') {
        console.log('Bot Discord wyłączony przez DISCORD_BOT_DISABLED.');
        return;
    }

    const { DISCORD_TOKEN: token, DISCORD_CLIENT_ID: clientId, DISCORD_GUILD_ID: guildId } = process.env;
    if (!token || !clientId) {
        console.warn('Bot Discord wyłączony: ustaw DISCORD_TOKEN i DISCORD_CLIENT_ID w pliku .env.');
        return;
    }

    const command = new SlashCommandBuilder()
        .setName('kodzamowienia')
        .setDescription('Pokazuje produkty i sumę zamówienia')
        .addStringOption(option => option.setName('kod').setDescription('Kod zamówienia, np. VL-...').setRequired(true));
    const ticketCommand = new SlashCommandBuilder()
        .setName('ticket')
        .setDescription('Tworzy prywatny ticket dla zamówienia')
        .addStringOption(option => option.setName('kod').setDescription('Kod zamówienia, np. VL-...').setRequired(true));
    const rest = new REST({ version: '10' }).setToken(token);
    const route = guildId
        ? Routes.applicationGuildCommands(clientId, guildId)
        : Routes.applicationCommands(clientId);
    await rest.put(route, { body: [command.toJSON(), ticketCommand.toJSON()] });

    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    client.once(Events.ClientReady, readyClient => console.log(`Bot Discord zalogowany jako ${readyClient.user.tag}`));
    client.on(Events.InteractionCreate, async interaction => {
        if (!interaction.isChatInputCommand()) return;

        const code = interaction.options.getString('kod', true).trim().toUpperCase();
        const order = orders.get(code);
        if (!order) {
            await interaction.reply({ content: 'Nie znaleziono zamówienia o podanym kodzie.', ephemeral: true });
            return;
        }

        const itemList = order.items.map(item => `• ${item.name} [${item.variant}] — ${item.price.toFixed(2)} PLN`).join('\n');
        const orderDetails = `**Zamówienie ${order.code}**\n\n${itemList}\n\n**Suma:** ${order.total.toFixed(2)} PLN\n**Wysyłka:** ${order.shipping}\n**Metoda płatności:** ${order.paymentMethod || 'Nie podano'}\n**Telefon:** ${order.phone || 'Nie podano'}\n**Paczkomat:** ${order.parcelLocker || 'Nie podano'}`;

        if (interaction.commandName === 'kodzamowienia') {
            await interaction.reply({ content: orderDetails, ephemeral: true });
            return;
        }

        if (!interaction.inGuild()) {
            await interaction.reply({ content: 'Tickety można tworzyć tylko na serwerze Discord.', ephemeral: true });
            return;
        }
        const existingChannel = interaction.guild.channels.cache.find(channel => channel.topic === `order:${order.code}`);
        if (existingChannel) {
            await interaction.reply({ content: `Ticket dla tego zamówienia już istnieje: ${existingChannel}`, ephemeral: true });
            return;
        }

        const ticketChannel = await interaction.guild.channels.create({
            name: `zamowienie-${order.code.slice(3, 11).toLowerCase()}`,
            type: ChannelType.GuildText,
            topic: `order:${order.code}`,
            permissionOverwrites: [
                { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
                { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
                { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] }
            ]
        });
        await ticketChannel.send({ content: `Ticket utworzony przez <@${interaction.user.id}>\n\n${orderDetails}` });
        await interaction.reply({ content: `Ticket został utworzony: ${ticketChannel}`, ephemeral: true });
    });
    await client.login(token);
}

startDiscordBot().catch(error => {
    console.error('Nie udało się uruchomić bota Discord:', error);
    process.exitCode = 1;
});