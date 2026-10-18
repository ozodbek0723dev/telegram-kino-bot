
require('dotenv').config();

const { Telegraf, Markup, Scenes, session } = require('telegraf');
const express = require('express');
const db = require('./database');

const token = process.env.BOT_TOKEN;
const adminId = String(process.env.ADMIN_ID || '');
const channelUsername = (process.env.CHANNEL_USERNAME || '').trim();
const botUsername = (process.env.BOT_USERNAME || '').replace(/^@/, '').trim();

if (!token) {
    console.error('XATOLIK: .env faylida BOT_TOKEN topilmadi!');
    process.exit(1);
}

if (!adminId) {
    console.error('XATOLIK: .env faylida ADMIN_ID topilmadi!');
    process.exit(1);
}

if (!channelUsername) {
    console.error('XATOLIK: .env faylida CHANNEL_USERNAME topilmadi!');
    process.exit(1);
}

if (!botUsername) {
    console.error('XATOLIK: .env faylida BOT_USERNAME topilmadi!');
    process.exit(1);
}

const bot = new Telegraf(token);
const channelChat = channelUsername;
const channelLink =
    `https://t.me/${channelUsername.replace(/^@/, '')}`;

const isAdmin = (ctx) =>
    String(ctx.from?.id || '') === adminId;

const escapeHtml = (value = '') =>
    String(value).replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[char]);

// ===============================
// ASOSIY MENYU
// ===============================

function mainMenuKeyboard(admin = false) {
    const buttons = [
        ['🔍 Kino qidirish', '⭐ Sevimlilar'],
        ['🆕 Yangi kinolar']
    ];

    if (admin) {
        buttons.push(['⚙️ Admin Panel']);
    }

    return Markup.keyboard(buttons).resize();
}

function subscriptionKeyboard() {
    return Markup.inlineKeyboard([
        [
            Markup.button.url(
                '📢 Kanalga obuna bo‘lish',
                channelLink
            )
        ],
        [
            Markup.button.callback(
                '✅ Obunani tekshirish',
                'check_sub'
            )
        ]
    ]);
}

// ===============================
// OBUNANI TEKSHIRISH
// ===============================

async function isSubscribed(ctx) {
    const member = await ctx.telegram.getChatMember(
        channelChat,
        ctx.from.id
    );

    return [
        'creator',
        'administrator',
        'member'
    ].includes(member.status);
}

async function checkSubscription(ctx, next) {
    if (isAdmin(ctx)) {
        return next();
    }

    try {
        const subscribed = await isSubscribed(ctx);

        if (!subscribed) {
            return ctx.reply(
                '⚠️ Botdan foydalanish uchun avval kanalga obuna bo‘ling:',
                subscriptionKeyboard()
            );
        }

        return next();
    } catch (err) {
        console.error('Obuna tekshirish xatosi:', err.message);

        return ctx.reply(
            '⚠️ Obunani tekshirib bo‘lmadi. Bot administratori kanal sozlamalarini tekshirishi kerak.'
        );
    }
}

// ===============================
// KINO YUBORISH
// ===============================

function findMovie(code) {
    return new Promise((resolve, reject) => {
        db.get(
            'SELECT * FROM movies WHERE code = ?',
            [String(code)],
            (err, movie) => {
                if (err) return reject(err);
                resolve(movie);
            }
        );
    });
}

function incrementViews(movieId) {
    return new Promise((resolve, reject) => {
        db.run(
            'UPDATE movies SET views = COALESCE(views, 0) + 1 WHERE id = ?',
            [movieId],
            function (err) {
                if (err) return reject(err);
                resolve();
            }
        );
    });
}

async function sendMovie(ctx, code) {
    try {
        const movie = await findMovie(code);

        if (!movie) {
            await ctx.reply(
                '❌ Bunday kodli kino topilmadi. Kino kodini tekshirib qayta yuboring.'
            );
            return;
        }

        if (!movie.video_file_id) {
            await ctx.reply('❌ Bu kinoda video fayli mavjud emas.');
            return;
        }

        await incrementViews(movie.id);

        const caption =
            `🎬 <b>${escapeHtml(movie.title)}</b>\n\n` +
            `📅 Yili: ${escapeHtml(movie.year || 'Noma’lum')}\n` +
            `🎭 Janr: ${escapeHtml(movie.genre || 'Noma’lum')}\n` +
            `🔢 Kodi: <code>${escapeHtml(movie.code)}</code>\n` +
            `👀 Ko‘rishlar: ${Number(movie.views || 0) + 1}`;

        await ctx.replyWithVideo(movie.video_file_id, {
            caption,
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [
                    Markup.button.callback(
                        '⭐ Sevimlilarga qo‘shish',
                        `fav_${movie.code}`
                    )
                ]
            ])
        });
    } catch (err) {
        console.error('Kino yuborish xatosi:', err.message);

        await ctx.reply(
            '❌ Kinoni yuborishda xatolik yuz berdi. Keyinroq urinib ko‘ring.'
        );
    }
}

// ===============================
// KINO QO‘SHISH WIZARD
// ===============================

async function cancelWizard(ctx) {
    await ctx.reply(
        '❌ Kino qo‘shish bekor qilindi.',
        mainMenuKeyboard(isAdmin(ctx))
    );

    return ctx.scene.leave();
}

const addMovieWizard = new Scenes.WizardScene(
    'add_movie_wizard',

    async (ctx) => {
        await ctx.reply(
            '🎬 Kino nomini kiriting:',
            Markup.keyboard([['❌ Bekor qilish']]).resize()
        );

        return ctx.wizard.next();
    },

    async (ctx) => {
        if (ctx.message?.text === '❌ Bekor qilish') {
            return cancelWizard(ctx);
        }

        if (!ctx.message?.text?.trim()) {
            return ctx.reply('⚠️ Kino nomini matn shaklida kiriting.');
        }

        ctx.scene.state.title = ctx.message.text.trim();

        await ctx.reply('🔢 Kino kodini kiriting (masalan: 101):');

        return ctx.wizard.next();
    },

    async (ctx) => {
        if (ctx.message?.text === '❌ Bekor qilish') {
            return cancelWizard(ctx);
        }

        if (!ctx.message?.text?.trim()) {
            return ctx.reply('⚠️ Kino kodini kiriting.');
        }

        ctx.scene.state.code = ctx.message.text.trim();

        await ctx.reply('📅 Kino chiqarilgan yilini kiriting:');

        return ctx.wizard.next();
    },

    async (ctx) => {
        if (ctx.message?.text === '❌ Bekor qilish') {
            return cancelWizard(ctx);
        }

        const year = Number(ctx.message?.text);

        if (
            !Number.isInteger(year) ||
            year < 1888 ||
            year > 2100
        ) {
            return ctx.reply(
                '⚠️ Yil noto‘g‘ri. Masalan: 2024'
            );
        }

        ctx.scene.state.year = year;

        await ctx.reply('🎭 Kino janrini kiriting:');

        return ctx.wizard.next();
    },

    async (ctx) => {
        if (ctx.message?.text === '❌ Bekor qilish') {
            return cancelWizard(ctx);
        }

        if (!ctx.message?.text?.trim()) {
            return ctx.reply('⚠️ Kino janrini kiriting.');
        }

        ctx.scene.state.genre = ctx.message.text.trim();

        await ctx.reply(
            '🎥 Endi kino videosini Telegram orqali yuboring.'
        );

        return ctx.wizard.next();
    },

    async (ctx) => {
        if (ctx.message?.text === '❌ Bekor qilish') {
            return cancelWizard(ctx);
        }

        if (!ctx.message?.video) {
            return ctx.reply(
                '⚠️ Iltimos, videoni Telegram video fayli sifatida yuboring.'
            );
        }

        ctx.scene.state.video = ctx.message.video.file_id;

        const s = ctx.scene.state;

        const summary =
            `📋 <b>Kino ma’lumotlari:</b>\n\n` +
            `🎬 Nomi: ${escapeHtml(s.title)}\n` +
            `🔢 Kodi: ${escapeHtml(s.code)}\n` +
            `📅 Yili: ${s.year}\n` +
            `🎭 Janr: ${escapeHtml(s.genre)}`;

        await ctx.reply(summary, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [
                    Markup.button.callback(
                        '✅ Saqlash va kanalga chiqarish',
                        'save_movie'
                    )
                ],
                [
                    Markup.button.callback(
                        '❌ Bekor qilish',
                        'cancel_movie'
                    )
                ]
            ])
        });

        return ctx.wizard.next();
    },

    async (ctx) => {
        // Tasdiqlash callback tugmalari action orqali ishlaydi.
        return;
    }
);

// ===============================
// KINONI SAQLASH VA KANALGA CHIQARISH
// ===============================

addMovieWizard.action('save_movie', async (ctx) => {
    await ctx.answerCbQuery();

    if (!isAdmin(ctx)) {
        return ctx.reply('⛔ Sizda admin huquqi yo‘q.');
    }

    const s = ctx.scene.state;

    if (!s.title || !s.code || !s.video) {
        await ctx.reply('❌ Kino ma’lumotlari to‘liq emas.');
        return ctx.scene.leave();
    }

    const date = new Date().toISOString();

    db.run(
        `INSERT INTO movies
        (code, title, description, year, genre,
         poster_file_id, video_file_id, created_at, views)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,

        [
            s.code,
            s.title,
            '',
            s.year,
            s.genre,
            '',
            s.video,
            date
        ],

        async function (err) {
            if (err) {
                console.error('Kino bazaga yozilmadi:', err.message);

                await ctx.reply(
                    '❌ Kino saqlanmadi. Kino kodi takrorlangan yoki bazada xatolik bor.'
                );

                return;
            }

            await ctx.reply(
                '✅ Kino bazaga saqlandi. Endi kanalga yuboraman...',
                mainMenuKeyboard(true)
            );

            try {
                const caption =
                    `🎬 <b>${escapeHtml(s.title)}</b>\n\n` +
                    `📅 Yili: ${s.year}\n` +
                    `🎭 Janr: ${escapeHtml(s.genre)}\n` +
                    `🔢 Kino kodi: <code>${escapeHtml(s.code)}</code>\n\n` +
                    `👇 Kinoni botda ko‘rish uchun tugmani bosing!`;

                await ctx.telegram.sendVideo(
                    channelChat,
                    s.video,
                    {
                        caption,
                        parse_mode: 'HTML',
                        ...Markup.inlineKeyboard([
                            [
                                Markup.button.url(
                                    '🎬 Botda ko‘rish',
                                    `https://t.me/${botUsername}?start=${encodeURIComponent(s.code)}`
                                )
                            ]
                        ])
                    }
                );

                await ctx.reply(
                    '📢 Kino kanalga muvaffaqiyatli chiqarildi!'
                );
            } catch (channelErr) {
                console.error(
                    'Kanalga yuborish xatosi:',
                    channelErr.message
                );

                await ctx.reply(
                    '⚠️ Kino bazaga saqlandi, lekin kanalga yuborilmadi. Botning kanalga admin qilib qo‘shilganini va video yuborish huquqini tekshiring.'
                );
            }

            await ctx.scene.leave();
        }
    );
});

addMovieWizard.action('cancel_movie', async (ctx) => {
    await ctx.answerCbQuery();

    return cancelWizard(ctx);
});

// ===============================
// SESSION VA SCENES
// ===============================

const stage = new Scenes.Stage([addMovieWizard]);

bot.use(session());
bot.use(stage.middleware());

// ===============================
// BOTNI ISHGA TUSHIRISH
// ===============================

bot.catch((err, ctx) => {
    console.error(
        `Bot xatosi (${ctx?.updateType || 'noma’lum'}):`,
        err.message
    );
});

// ===============================
// /START VA KANALDAN KELGAN KINO
// ===============================

bot.start(async (ctx) => {
    const user = ctx.from;

    db.run(
        `INSERT OR IGNORE INTO users
        (telegram_id, username, first_name, joined_at)
        VALUES (?, ?, ?, ?)`,

        [
            String(user.id),
            user.username || '',
            user.first_name || '',
            new Date().toISOString()
        ]
    );

    const startPayload = ctx.startPayload;

    if (!isAdmin(ctx)) {
        try {
            const subscribed = await isSubscribed(ctx);

            if (!subscribed) {
                if (startPayload) {
                    ctx.session.pendingMovieCode = startPayload;
                }

                return ctx.reply(
                    '⚠️ Kino ko‘rish uchun avval kanalimizga obuna bo‘ling:',
                    subscriptionKeyboard()
                );
            }
        } catch (err) {
            console.error(
                'Start obuna tekshirish xatosi:',
                err.message
            );

            return ctx.reply(
                '⚠️ Obunani tekshirib bo‘lmadi. Keyinroq urinib ko‘ring.'
            );
        }
    }

    // Kanal e’lonidagi /start KINO_KODI havolasi
    if (startPayload) {
        return sendMovie(ctx, startPayload);
    }

    return ctx.reply(
        `Assalomu alaykum, <b>${escapeHtml(user.first_name || 'foydalanuvchi')}</b>!\n\n` +
        '🎬 Kino botimizga xush kelibsiz!\n' +
        'Kino kodini yuboring yoki menyudan tanlang.',
        {
            parse_mode: 'HTML',
            ...mainMenuKeyboard(isAdmin(ctx))
        }
    );
});

// ===============================
// OBUNANI QAYTA TEKSHIRISH
// ===============================

bot.action('check_sub', async (ctx) => {
    await ctx.answerCbQuery();

    try {
        const subscribed = await isSubscribed(ctx);

        if (!subscribed) {
            return ctx.reply(
                '❌ Siz hali kanalga obuna bo‘lmagansiz.',
                subscriptionKeyboard()
            );
        }

        const pendingCode = ctx.session.pendingMovieCode;

        delete ctx.session.pendingMovieCode;

        await ctx.reply('✅ Obunangiz tasdiqlandi!');

        if (pendingCode) {
            return sendMovie(ctx, pendingCode);
        }

        return ctx.reply(
            '🎬 Endi botdan foydalanishingiz mumkin.',
            mainMenuKeyboard(isAdmin(ctx))
        );
    } catch (err) {
        console.error(
            'Obuna callback xatosi:',
            err.message
        );

        return ctx.reply(
            '⚠️ Obunani tekshirishda xatolik yuz berdi. Kanal sozlamalarini tekshiring.'
        );
    }
});

// ===============================
// YANGI KINOLAR
// ===============================

bot.hears('🆕 Yangi kinolar', checkSubscription, async (ctx) => {
    await ctx.reply(
        '📢 Yangi kinolarimizni kanalimizdan tomosha qiling:',
        Markup.inlineKeyboard([
            [
                Markup.button.url(
                    '🎬 Kanalga o‘tish',
                    channelLink
                )
            ]
        ])
    );
});

// ===============================
// ADMIN PANEL
// ===============================

bot.hears('⚙️ Admin Panel', async (ctx) => {
    if (!isAdmin(ctx)) {
        return ctx.reply('⛔ Sizda admin huquqi yo‘q.');
    }

    await ctx.reply(
        '🛠 <b>Admin boshqaruv paneli</b>',
        {
            parse_mode: 'HTML',
            ...Markup.keyboard([
                ['➕ Kino qo‘shish', '📋 Barcha kinolar'],
                ['📊 Statistika', '🔙 Asosiy menyu']
            ]).resize()
        }
    );
});

bot.hears('🔙 Asosiy menyu', async (ctx) => {
    return ctx.reply(
        '🏠 Asosiy menyu:',
        mainMenuKeyboard(isAdmin(ctx))
    );
});

bot.hears('➕ Kino qo‘shish', async (ctx) => {
    if (!isAdmin(ctx)) {
        return ctx.reply('⛔ Sizda admin huquqi yo‘q.');
    }

    return ctx.scene.enter('add_movie_wizard');
});

// ===============================
// BARCHA KINOLAR
// ===============================

bot.hears('📋 Barcha kinolar', async (ctx) => {
    if (!isAdmin(ctx)) {
        return ctx.reply('⛔ Sizda admin huquqi yo‘q.');
    }

    db.all(
        'SELECT code, title, year FROM movies ORDER BY id DESC',
        [],
        async (err, rows) => {
            if (err) {
                console.error(err.message);
                return ctx.reply('❌ Kinolarni olishda xatolik.');
            }

            if (!rows || rows.length === 0) {
                return ctx.reply('📭 Hozircha kinolar yo‘q.');
            }

            let list = '📋 <b>Barcha kinolar:</b>\n\n';

            for (const movie of rows.slice(0, 50)) {
                list +=
                    `🎬 ${escapeHtml(movie.title)}\n` +
                    `🔢 Kod: <code>${escapeHtml(movie.code)}</code>\n` +
                    `📅 Yil: ${escapeHtml(movie.year || 'Noma’lum')}\n\n`;
            }

            await ctx.reply(list, {
                parse_mode: 'HTML'
            });

            if (rows.length > 50) {
                await ctx.reply(
                    `Jami ${rows.length} ta kino bor. Hozir dastlabki 50 tasi ko‘rsatildi.`
                );
            }
        }
    );
});

// ===============================
// STATISTIKA
// ===============================

bot.hears('📊 Statistika', async (ctx) => {
    if (!isAdmin(ctx)) {
        return ctx.reply('⛔ Sizda admin huquqi yo‘q.');
    }

    db.get(
        'SELECT COUNT(*) AS count FROM users',
        [],
        (err, users) => {
            if (err) {
                console.error(err.message);
                return ctx.reply('❌ Statistika olishda xatolik.');
            }

            db.get(
                'SELECT COUNT(*) AS count FROM movies',
                [],
                (err2, movies) => {
                    if (err2) {
                        console.error(err2.message);
                        return ctx.reply('❌ Statistika olishda xatolik.');
                    }

                    db.get(
                        'SELECT COALESCE(SUM(views), 0) AS total FROM movies',
                        [],
                        async (err3, views) => {
                            if (err3) {
                                console.error(err3.message);
                                return ctx.reply('❌ Statistika olishda xatolik.');
                            }

                            await ctx.reply(
                                `📊 <b>Bot statistikasi</b>\n\n` +
                                `👥 Foydalanuvchilar: ${users.count}\n` +
                                `🎬 Kinolar: ${movies.count}\n` +
                                `👀 Ko‘rishlar: ${views.total}`,
                                { parse_mode: 'HTML' }
                            );
                        }
                    );
                }
            );
        }
    );
});

// ===============================
// KINO QIDIRISH
// ===============================

bot.hears('🔍 Kino qidirish', checkSubscription, async (ctx) => {
    await ctx.reply(
        '🔍 Kino kodini yoki nomini yuboring:'
    );
});

// ===============================
// SEVIMLILAR
// ===============================

bot.hears('⭐ Sevimlilar', checkSubscription, async (ctx) => {
    const userId = String(ctx.from.id);

    db.all(
        `SELECT m.code, m.title, m.year, m.genre
         FROM movies m
         INNER JOIN favorites f ON m.code = f.movie_code
         WHERE f.telegram_id = ?`,
        [userId],
        async (err, rows) => {
            if (err) {
                console.error(err.message);
                return ctx.reply(
                    '❌ Sevimlilarni olishda xatolik.'
                );
            }

            if (!rows || rows.length === 0) {
                return ctx.reply(
                    '⭐ Sevimlilar ro‘yxatingiz hozircha bo‘sh.'
                );
            }

            let list = '⭐ <b>Sizning sevimli kinolaringiz:</b>\n\n';

            for (const movie of rows.slice(0, 40)) {
                list +=
                    `🎬 ${escapeHtml(movie.title)} (${escapeHtml(movie.year || '—')})\n` +
                    `🎭 ${escapeHtml(movie.genre || '—')}\n` +
                    `🔢 Kod: <code>${escapeHtml(movie.code)}</code>\n\n`;
            }

            await ctx.reply(list, {
                parse_mode: 'HTML'
            });

            await ctx.reply(
                '🎥 Kinoni ko‘rish uchun uning kodini yuboring.'
            );
        }
    );
});

// ===============================
// KINO KODI YOKI NOMI BO‘YICHA QIDIRISH
// ===============================

const menuButtons = [
    '🔍 Kino qidirish',
    '⭐ Sevimlilar',
    '🆕 Yangi kinolar',
    '⚙️ Admin Panel',
    '➕ Kino qo‘shish',
    '📋 Barcha kinolar',
    '📊 Statistika',
    '🔙 Asosiy menyu',
    '❌ Bekor qilish'
];

bot.on('text', checkSubscription, async (ctx) => {
    const text = ctx.message.text.trim();

    if (!text || text.startsWith('/') || menuButtons.includes(text)) {
        return;
    }

    try {
        const movie = await new Promise((resolve, reject) => {
            db.get(
                `SELECT * FROM movies
                 WHERE code = ? OR title LIKE ?
                 ORDER BY CASE WHEN code = ? THEN 0 ELSE 1 END
                 LIMIT 1`,
                [text, `%${text}%`, text],
                (err, row) => {
                    if (err) return reject(err);
                    resolve(row);
                }
            );
        });

        if (!movie) {
            return ctx.reply(
                '❌ Bunday kino topilmadi. Kino kodi yoki nomini tekshiring.'
            );
        }

        return sendMovie(ctx, movie.code);
    } catch (err) {
        console.error('Kino qidirish xatosi:', err.message);

        return ctx.reply(
            '❌ Qidirishda xatolik yuz berdi.'
        );
    }
});

// ===============================
// SEVIMLILARGA QO‘SHISH
// ===============================

bot.action(/^fav_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();

    const code = ctx.match[1];
    const userId = String(ctx.from.id);

    db.run(
        `INSERT OR IGNORE INTO favorites
         (telegram_id, movie_code)
         VALUES (?, ?)`,
        [userId, code],
        function (err) {
            if (err) {
                console.error(err.message);

                return ctx.reply(
                    '❌ Sevimlilarga qo‘shishda xatolik.'
                );
            }

            if (this.changes > 0) {
                return ctx.reply(
                    '⭐ Kino sevimlilar ro‘yxatiga qo‘shildi!'
                );
            }

            return ctx.reply(
                'ℹ️ Bu kino sevimlilaringiz ro‘yxatida allaqachon bor.'
            );
        }
    );
});

// ===============================
// BOTNI ISHGA TUSHIRISH
// ===============================

const app = express();
const PORT = process.env.PORT || 3000;
const webhookPath = '/telegram-webhook';

app.use(express.json());

app.use(bot.webhookCallback(webhookPath));

app.get('/', (req, res) => {
  res.send('Kino bot serveri ishlayapti!');
});

app.listen(PORT, async () => {
  try {
    const url = process.env.RENDER_EXTERNAL_URL;

    if (!url) {
      throw new Error('RENDER_EXTERNAL_URL topilmadi');
    }

    await bot.telegram.setWebhook(`${url}${webhookPath}`);
    console.log('✅ Kino bot webhook orqali ishga tushdi!');
    console.log(`🌐 Server porti: ${PORT}`);
  } catch (err) {
    console.error('❌ Webhook xatosi:', err.message);
  }
});