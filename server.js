// server.js - Currículo em Minutos (Node + Express + Stripe + MongoDB)

require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const PDFDocument = require('pdfkit');
const mongoose = require('mongoose');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const OpenAI = require('openai');
const Groq = require('groq-sdk');
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});






// ⚠️ IMPORTANTE:
// Configure estas variáveis no seu .env:
// MONGODB_URI=mongodb+srv://usuario:senha@cluster/db
// STRIPE_SECRET_KEY=sk_test_xxx
// STRIPE_WEBHOOK_SECRET=whsec_xxx
// FRONTEND_BASE_URL=https://seu-dominio.com  (ou http://localhost:3000 em dev)
// ADMIN_TOKEN=uma_senha_forte_para_painel
// PORT=3000

const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || 'http://localhost:3000';
const PORT = process.env.PORT || 3000;

const app = express();

const allowedOrigins = [
  'http://localhost:3000',              // quando você está testando local
  'https://my-curriculo-xe5a.vercel.app' // quando estiver usando o site na Vercel
];

app.use(
  cors({
    origin(origin, callback) {
      // Permite requisições sem origin (ex: curl, Postman)
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error('Origin não permitido pelo CORS'));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// importante: manter também
app.use(express.json());


/**
 * 1) WEBHOOK DO STRIPE
 *    Precisa do corpo "raw" ANTES do express.json().
 *    Configure o endpoint no painel do Stripe apontando para:
 *    POST /api/webhooks/stripe
 */
app.post(
  '/api/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('Erro ao verificar webhook Stripe:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Tratando eventos de pagamento
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const orderId = session.metadata?.orderId;

      if (orderId) {
        try {
          await Order.findOneAndUpdate(
            { orderId },
            {
              paid: true,
              paymentStatus: session.payment_status,
              paymentProvider: 'stripe',
              paymentSessionId: session.id
            }
          );
          console.log(`Pedido ${orderId} marcado como pago.`);
        } catch (err) {
          console.error('Erro ao atualizar pedido após webhook:', err);
        }
      }
    }

    res.json({ received: true });
  }
);

// 2) MIDDLEWARES "NORMAIS" (depois do webhook)
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// 3) CONEXÃO COM O BANCO (MongoDB)
mongoose
  .connect(process.env.MONGODB_URI, {
    autoIndex: true
  })
  .then(() => console.log('✅ Conectado ao MongoDB'))
  .catch((err) => console.error('Erro ao conectar ao MongoDB:', err));

// 4) MODEL DE PEDIDO
const orderSchema = new mongoose.Schema(
  {
    orderId: { type: String, unique: true, index: true },
    price: { type: Number, default: 19.9 },
    currency: { type: String, default: 'BRL' },
    paid: { type: Boolean, default: false },
    paymentStatus: { type: String, default: 'pending' },
    paymentProvider: { type: String, default: 'stripe' },
    paymentSessionId: { type: String },

    template: { type: String, default: 'claro' },
    data: {
      dadosPessoais: Object,
      objetivo: Object,
      experiencias: Array,
      formacao: Array,
      habilidades: Array,
      idiomas: Array,
      cursos: Array
    }
  },
  { timestamps: true }
);

const Order = mongoose.model('Order', orderSchema);

// Helper para IDs
const generateId = () =>
  Date.now().toString(36) + Math.random().toString(36).substring(2, 8);

/**
 * 5) CRIAR PEDIDO (antes do pagamento)
 *    Essa rota salva tudo no DB e devolve orderId + preço.
 */
app.post('/api/create-order', async (req, res) => {
  try {
    const {
      dadosPessoais,
      objetivo,
      experiencias,
      formacao,
      habilidades,
      idiomas,
      cursos,
      template
    } = req.body;

    if (!dadosPessoais || !dadosPessoais.nome || !dadosPessoais.email) {
      return res.status(400).json({
        error: 'Nome e e-mail são obrigatórios.'
      });
    }

    const orderId = generateId();
    const price = 19.9; // valor configurável

    const order = await Order.create({
      orderId,
      price,
      currency: 'BRL',
      template: template || 'claro',
      data: {
        dadosPessoais,
        objetivo,
        experiencias,
        formacao,
        habilidades,
        idiomas,
        cursos
      }
    });

    res.json({
      orderId: order.orderId,
      price: order.price,
      currency: order.currency
    });
  } catch (err) {
    console.error('Erro ao criar pedido:', err);
    res.status(500).json({ error: 'Erro ao criar pedido.' });
  }
});

/**
 * 6) PEGAR PEDIDO (para mostrar na página de pagamento)
 */
app.get('/api/order/:id', async (req, res) => {
  try {
    const order = await Order.findOne({ orderId: req.params.id }).lean();
    if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });

    res.json({
      orderId: order.orderId,
      paid: order.paid,
      price: order.price,
      currency: order.currency,
      paymentStatus: order.paymentStatus
    });
  } catch (err) {
    console.error('Erro ao buscar pedido:', err);
    res.status(500).json({ error: 'Erro ao buscar pedido.' });
  }
});


/**
 * 7) CRIAR SESSÃO DE CHECKOUT DO STRIPE
 *    Só o backend fala com o Stripe. O front apenas recebe a URL de checkout.
 */
app.post('/api/order/:id/checkout-session', async (req, res) => {
  try {
    const order = await Order.findOne({ orderId: req.params.id });
    if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });

    if (order.paid) {
      // já pago: não precisa criar novo checkout
      return res.json({ alreadyPaid: true });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: order.currency.toLowerCase(),
            unit_amount: Math.round(order.price * 100), // em centavos
            product_data: {
              name: 'Download de Currículo Profissional (PDF)',
              description:
                'Currículo gerado automaticamente com base nos seus dados.'
            }
          },
          quantity: 1
        }
      ],
      metadata: {
        orderId: order.orderId
      },
      success_url: `${FRONTEND_BASE_URL}/pagamento.html?orderId=${order.orderId}&status=success`,
      cancel_url: `${FRONTEND_BASE_URL}/pagamento.html?orderId=${order.orderId}&status=cancel`
    });

    order.paymentSessionId = session.id;
    order.paymentProvider = 'stripe';
    await order.save();

    res.json({
      checkoutUrl: session.url
    });
  } catch (err) {
    console.error('Erro ao criar sessão de checkout:', err);
    res.status(500).json({ error: 'Erro ao criar sessão de pagamento.' });
  }
});

/**
 * 8) PAINEL ADMIN SIMPLES
 *    Lista pedidos com base em um token de admin via query string (?token=...).
 *    NÃO é autenticação forte, mas já é melhor que nada para um painel interno.
 */
app.get('/api/admin/orders', async (req, res) => {
  const token = req.query.token;
  if (!process.env.ADMIN_TOKEN) {
    return res.status(500).json({ error: 'ADMIN_TOKEN não configurado.' });
  }
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Não autorizado.' });
  }

  try {
    const orders = await Order.find()
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    const sanitized = orders.map((o) => ({
      orderId: o.orderId,
      paid: o.paid,
      price: o.price,
      currency: o.currency,
      paymentStatus: o.paymentStatus,
      template: o.template,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
      nome: o.data?.dadosPessoais?.nome || '',
      email: o.data?.dadosPessoais?.email || ''
    }));

    res.json({ orders: sanitized });
  } catch (err) {
    console.error('Erro ao listar pedidos admin:', err);
    res.status(500).json({ error: 'Erro ao listar pedidos.' });
  }
});

/**
 * 9) DOWNLOAD DO PDF – PAYWALL REAL
 *    Só libera se o pedido estiver com paid = true (marcado via webhook).
 */
app.get('/api/order/:id/pdf', async (req, res) => {
  try {
    const order = await Order.findOne({ orderId: req.params.id }).lean();
    if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });

    if (!order.paid) {
      return res.status(403).json({
        error: 'Pagamento ainda não confirmado. Download não autorizado.'
      });
    }

    const {
      dadosPessoais,
      objetivo,
      experiencias,
      formacao,
      habilidades,
      idiomas,
      cursos
    } = order.data || {};

    const filename = `curriculo-${(dadosPessoais?.nome || 'usuario')
      .toLowerCase()
      .replace(/\s+/g, '-')}.pdf`;

    res.setHeader(
      'Content-disposition',
      'attachment; filename="' + filename + '"'
    );
    res.setHeader('Content-type', 'application/pdf');

    const doc = new PDFDocument({
      margin: 50
    });

    doc.pipe(res);

    // ====== CORES E ESTILO BASE ======
    const isEscuro = order.template === 'escuro';

    const primaryColor = isEscuro ? '#111827' : '#000000'; // texto principal
    const sectionTitleColor = isEscuro ? '#111827' : '#000000';
    const subtleTextColor = isEscuro ? '#4B5563' : '#4B5563';
    const lineColor = isEscuro ? '#E5E7EB' : '#E5E7EB';

    if (isEscuro) {
      doc.rect(0, 0, doc.page.width, doc.page.height).fill('#F9FAFB');
      doc.fillColor(primaryColor);
    }

    // ====== CABEÇALHO (NOME + "CARGO") ======
    const nome = dadosPessoais?.nome || '';
    // subtítulo: usamos uma versão curta do objetivo ou um placeholder
    let subTitulo = '';
    if (objetivo?.texto) {
      // pega só a primeira frase ou até ~60 caracteres
      const primeiraFrase = objetivo.texto.split(/[.!?]/)[0];
      subTitulo =
        primeiraFrase.length > 60
          ? primeiraFrase.slice(0, 57).trim() + '...'
          : primeiraFrase.trim();
    }

    doc
      .font('Helvetica-Bold')
      .fontSize(20)
      .fillColor(primaryColor)
      .text(nome.toUpperCase(), { align: 'left' });

    if (subTitulo) {
      doc
        .moveDown(0.3)
        .font('Helvetica')
        .fontSize(11)
        .fillColor(subtleTextColor)
        .text(subTitulo, { align: 'left' });
    }

    doc.moveDown(0.8);

    // ====== LINHA HORIZONTAL ======
    doc
      .moveTo(doc.page.margins.left, doc.y)
      .lineTo(doc.page.width - doc.page.margins.right, doc.y)
      .lineWidth(1)
      .strokeColor(lineColor)
      .stroke();

    doc.moveDown(0.8);

    // ====== LINHA DE CONTATOS (telefone · email · cidade/estado) ======
    const contatos = [];

    if (dadosPessoais?.telefone) contatos.push(dadosPessoais.telefone);
    if (dadosPessoais?.email) contatos.push(dadosPessoais.email);

    const localParts = [dadosPessoais?.cidade, dadosPessoais?.estado].filter(
      Boolean
    );
    if (localParts.length) contatos.push(localParts.join(' - '));

    if (contatos.length) {
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(subtleTextColor)
        .text(contatos.join('  ·  '), { align: 'left' });
    }

    if (dadosPessoais?.linkedin || dadosPessoais?.site) {
      const links = [dadosPessoais.linkedin, dadosPessoais.site]
        .filter(Boolean)
        .join('  ·  ');
      if (links) {
        doc
          .moveDown(0.2)
          .fontSize(9)
          .fillColor(subtleTextColor)
          .text(links, { align: 'left' });
      }
    }

    doc.moveDown(1);

    // Helper para títulos de seção no estilo da imagem
    const addSectionTitle = (title) => {
      doc
        .moveDown(0.5)
        .font('Helvetica-Bold')
        .fontSize(11)
        .fillColor(sectionTitleColor)
        .text(title.toUpperCase(), { align: 'left' });

      doc
        .moveDown(0.15)
        .moveTo(doc.page.margins.left, doc.y)
        .lineTo(doc.page.width - doc.page.margins.right, doc.y)
        .lineWidth(0.7)
        .strokeColor(lineColor)
        .stroke();

      doc.moveDown(0.4);
    };

    // ====== OBJETIVOS ======
    if (objetivo && objetivo.texto) {
      addSectionTitle('Objetivos');
      doc
        .font('Helvetica')
        .fontSize(10)
        .fillColor(primaryColor)
        .text(objetivo.texto, {
          align: 'left'
        });
      doc.moveDown(0.8);
    }

    // ====== FORMAÇÃO ======
    if (Array.isArray(formacao) && formacao.length) {
      addSectionTitle('Formação');

      formacao.forEach((f) => {
        if (!f.curso) return;

        const periodo = [f.inicio, f.fim].filter(Boolean).join(' - ');

        doc
          .font('Helvetica-Bold')
          .fontSize(10)
          .fillColor(primaryColor)
          .text(
            `${(f.inicio || '') && (f.fim || '')
              ? `${f.inicio} - ${f.fim}  |  `
              : ''
            }${f.curso}`,
            { align: 'left' }
          );

        if (f.instituicao) {
          doc
            .moveDown(0.1)
            .font('Helvetica')
            .fontSize(9)
            .fillColor(subtleTextColor)
            .text(f.instituicao, { align: 'left' });
        }

        doc.moveDown(0.6);
      });
    }

    // ====== EXPERIÊNCIAS ======
    if (Array.isArray(experiencias) && experiencias.length) {
      addSectionTitle('Experiências');

      experiencias.forEach((exp) => {
        if (!exp.cargo && !exp.empresa) return;

        // linha 1: período | cargo
        const periodo = [exp.inicio, exp.fim || 'Atual']
          .filter(Boolean)
          .join(' - ');

        doc
          .font('Helvetica-Bold')
          .fontSize(10)
          .fillColor(primaryColor)
          .text(
            `${periodo ? periodo + '  |  ' : ''}${exp.cargo || ''}`,
            { align: 'left' }
          );

        // linha 2: empresa + localidade
        const empresaLocal = [exp.empresa, exp.localidade]
          .filter(Boolean)
          .join(' - ');

        if (empresaLocal) {
          doc
            .moveDown(0.1)
            .font('Helvetica')
            .fontSize(9)
            .fillColor(subtleTextColor)
            .text(empresaLocal, { align: 'left' });
        }

        // descrição
        if (exp.descricao) {
          doc
            .moveDown(0.2)
            .font('Helvetica')
            .fontSize(10)
            .fillColor(primaryColor)
            .text(exp.descricao, {
              align: 'left'
            });
        }

        doc.moveDown(0.8);
      });
    }

    // ====== HABILIDADES (opcional, no final) ======
    if (Array.isArray(habilidades) && habilidades.length) {
      addSectionTitle('Habilidades');
      doc
        .font('Helvetica')
        .fontSize(10)
        .fillColor(primaryColor)
        .text(habilidades.join('  •  '), {
          align: 'left'
        });
      doc.moveDown(0.6);
    }

    // ====== IDIOMAS ======
    if (Array.isArray(idiomas) && idiomas.length) {
      addSectionTitle('Idiomas');
      idiomas.forEach((idioma) => {
        if (!idioma.nome) return;
        doc
          .font('Helvetica')
          .fontSize(10)
          .fillColor(primaryColor)
          .text(
            `${idioma.nome}${idioma.nivel ? ' – ' + idioma.nivel : ''}`,
            { align: 'left' }
          );
      });
      doc.moveDown(0.6);
    }

    // ====== CURSOS ======
    if (Array.isArray(cursos) && cursos.length) {
      addSectionTitle('Cursos Complementares');
      cursos.forEach((curso) => {
        if (!curso.nome) return;
        doc
          .font('Helvetica')
          .fontSize(10)
          .fillColor(primaryColor)
          .text(
            `${curso.nome}${curso.instituicao ? ' – ' + curso.instituicao : ''}`,
            { align: 'left' }
          );
        doc.moveDown(0.3);
      });
    }

    doc.end();
  } catch (err) {
    console.error('Erro ao gerar PDF:', err);
    res.status(500).json({ error: 'Erro ao gerar PDF.' });
  }
});

/**
 * IA: Gerar texto de objetivo profissional com Groq (Llama 3)
 * Endpoint chamado pelo criador.html: POST /api/ia/objetivo
 */

/**
 * IA: Gerar texto de objetivo profissional com Groq (Llama 3)
 * Endpoint chamado pelo criador.html: POST /api/ia/objetivo
 */
app.post('/api/ia/objetivo', async (req, res) => {
  try {
    const {
      cargo,
      area,
      nivel,
      experiencia,
      pontosExtras,
      tipoVaga
    } = req.body || {};

    if (!cargo) {
      return res.status(400).json({
        error: 'Informe pelo menos o cargo desejado.'
      });
    }

    if (!process.env.GROQ_API_KEY) {
      console.error('GROQ_API_KEY não configurada no .env');
      return res.status(500).json({
        error: 'IA ainda não está configurada no servidor.'
      });
    }

    const prompt = `
Gere um objetivo profissional em primeira pessoa, em português do Brasil,
com tom profissional, entre 2 e 4 frases.

Use os dados abaixo:
- Cargo desejado: ${cargo || ''}
- Área / segmento: ${area || ''}
- Nível de senioridade: ${nivel || ''}
- Tempo de experiência: ${experiencia || ''}
- Tipo de vaga: ${tipoVaga || ''}
- Pontos para destacar: ${pontosExtras || ''}

Entregue APENAS o texto do objetivo, sem títulos ou marcadores.
    `;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content:
            'Você escreve objetivos profissionais curtos, claros e objetivos para currículos em português do Brasil.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.6,
      max_tokens: 200
    });

    const texto =
      completion.choices?.[0]?.message?.content?.trim() ||
      'Profissional em busca de novas oportunidades.';

    return res.json({ texto });
  } catch (err) {
    console.error('Erro na rota /api/ia/objetivo (Groq):', err);
    return res.status(500).json({
      error: 'Erro interno ao gerar objetivo com IA.'
    });
  }
});



/**
 * 10) SPA / ROTA CATCH-ALL
 *     Mantém comportamento de servir index.html para rotas desconhecidas.
 */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/**
 * 11) HTTPS EM PRODUÇÃO
 *     Em produção, use um proxy (Nginx, Caddy, etc.) com HTTPS na frente.
 */
app.listen(PORT, () => {
  console.log(`Servidor rodando em ${FRONTEND_BASE_URL} (porta ${PORT})`);
});
