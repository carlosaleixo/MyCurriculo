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
  'https://mycurriculo.vercel.app' // quando estiver usando o site na Vercel
];

// 0) CORS GLOBAL
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

// ⚠️ NÃO usar express.json() aqui em cima antes do webhook!

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
      console.log('🔔 Recebendo webhook do Stripe...');
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
      console.log('✅ Webhook verificado:', event.type);
    } catch (err) {
      console.error('❌ Erro ao verificar webhook Stripe:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Tratando eventos de pagamento
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const orderId = session.metadata?.orderId;

      console.log('🧾 checkout.session.completed para orderId:', orderId);

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
          console.log(`✅ Pedido ${orderId} marcado como pago.`);
        } catch (err) {
          console.error('Erro ao atualizar pedido após webhook:', err);
        }
      }
    }

    res.json({ received: true });
  }
);

// 2) MIDDLEWARES "NORMAIS" (depois do webhook)
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

// 4) SCHEMA / MODEL DO PEDIDO
const orderSchema = new mongoose.Schema(
  {
    orderId: { type: String, unique: true, index: true },
    price: { type: Number, default: 19.9 },
    currency: { type: String, default: 'BRL' },
    paid: { type: Boolean, default: false },
    paymentStatus: { type: String, default: 'pending' },
    paymentProvider: { type: String, default: 'stripe' },
    paymentSessionId: { type: String },

    template: { type: String, default: 'classico' },
    data: {
      dadosPessoais: Object,
      objetivo: Object,
      experiencias: Array,
      formacoes: Array,
      cursos: Array,
      habilidades: Array,
      idiomas: Array,
      redesSociais: Array,
      extras: Array
    }
  },
  {
    timestamps: true
  }
);

const Order = mongoose.model('Order', orderSchema);

// 5) ROTA PARA CRIAR PEDIDO
app.post('/api/create-order', async (req, res) => {
  try {
    const {
      dadosPessoais,
      objetivo,
      experiencias,
      formacoes,
      cursos,
      habilidades,
      idiomas,
      redesSociais,
      extras,
      template,
      price
    } = req.body;

    // Gera um ID único amigável
    const orderId = `ORD-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

    const order = new Order({
      orderId,
      price: price || 19.9,
      template: template || 'classico',
      data: {
        dadosPessoais,
        objetivo,
        experiencias,
        formacoes,
        cursos,
        habilidades,
        idiomas,
        redesSociais,
        extras
      }
    });

    await order.save();

    res.status(201).json({
      success: true,
      message: 'Pedido criado com sucesso.',
      orderId: order.orderId
    });
  } catch (err) {
    console.error('Erro ao criar pedido:', err);
    res.status(500).json({ error: 'Erro ao criar pedido.' });
  }
});

// 6) ROTA PARA OBTER DETALHES DO PEDIDO
app.get('/api/order/:id', async (req, res) => {
  try {
    const order = await Order.findOne({ orderId: req.params.id });

    if (!order) {
      return res.status(404).json({ error: 'Pedido não encontrado.' });
    }

    res.json(order);
  } catch (err) {
    console.error('Erro ao buscar pedido:', err);
    res.status(500).json({ error: 'Erro ao buscar pedido.' });
  }
});

// 7) ROTA PARA CRIAR SESSÃO DE PAGAMENTO (CHECKOUT)
app.post('/api/order/:id/checkout-session', async (req, res) => {
  try {
    const order = await Order.findOne({ orderId: req.params.id });

    if (!order) {
      return res.status(404).json({ error: 'Pedido não encontrado.' });
    }

    // Se já estiver pago, não precisa criar nova sessão
    if (order.paid) {
      return res.json({
        success: true,
        alreadyPaid: true,
        message: 'Pedido já pago.'
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'brl',
            product_data: {
              name: 'Currículo Profissional em PDF'
            },
            unit_amount: Math.round(order.price * 100) // R$ -> centavos
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

    res.json({
      success: true,
      checkoutUrl: session.url
    });
  } catch (err) {
    console.error('Erro ao criar sessão de pagamento:', err);
    res.status(500).json({ error: 'Erro ao criar sessão de pagamento.' });
  }
});

// 8) PAINEL ADMIN SIMPLES
app.get('/api/admin/orders', async (req, res) => {
  const token = req.query.token;
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Não autorizado.' });
  }

  try {
    const orders = await Order.find().sort({ createdAt: -1 }).limit(100);
    res.json(orders);
  } catch (err) {
    console.error('Erro ao listar pedidos:', err);
    res.status(500).json({ error: 'Erro ao listar pedidos.' });
  }
});

// 9) ROTA PARA GERAR / BAIXAR PDF DO CURRÍCULO
app.get('/api/order/:id/pdf', async (req, res) => {
  try {
    const order = await Order.findOne({ orderId: req.params.id }).lean();
    if (!order) {
      return res.status(404).json({ error: 'Pedido não encontrado.' });
    }

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

    const doc = new PDFDocument({ margin: 50 });
    doc.pipe(res);

    const rawTemplate = order.template || 'classico';
    const template =
      rawTemplate === 'classico' || rawTemplate === 'moderno'
        ? rawTemplate
        : rawTemplate === 'escuro'
        ? 'moderno'
        : 'classico';

    if (template === 'classico') {
      renderClassic(doc, {
        dadosPessoais,
        objetivo,
        experiencias,
        formacao,
        habilidades,
        idiomas,
        cursos
      });
    } else {
      renderModern(doc, {
        dadosPessoais,
        objetivo,
        experiencias,
        formacao,
        habilidades,
        idiomas,
        cursos
      });
    }

    doc.end();
  } catch (err) {
    console.error('Erro ao gerar PDF:', err);
    res.status(500).json({ error: 'Erro ao gerar PDF.' });
  }

  // =====================
  //  MODELO CLÁSSICO
  // =====================
  function renderClassic(
    doc,
    { dadosPessoais, objetivo, experiencias, formacao, habilidades, idiomas, cursos }
  ) {
    const primaryColor = '#000000';
    const subtleText = '#4B5563';

    const nome = dadosPessoais?.nome || 'Nome do Profissional';

    // Cabeçalho centralizado (como na primeira imagem)
    doc
      .font('Helvetica-Bold')
      .fontSize(16)
      .fillColor(primaryColor)
      .text(nome, { align: 'center' });

    const linha1 = [];
    if (dadosPessoais?.cidade || dadosPessoais?.estado) {
      linha1.push(
        [dadosPessoais.cidade, dadosPessoais.estado].filter(Boolean).join(' / ')
      );
    }
    if (dadosPessoais?.email) linha1.push(dadosPessoais.email);
    if (dadosPessoais?.telefone) linha1.push(dadosPessoais.telefone);

    const linha2 = [];
    if (dadosPessoais?.linkedin) linha2.push(dadosPessoais.linkedin);
    if (dadosPessoais?.site) linha2.push(dadosPessoais.site);

    doc.moveDown(0.3);
    if (linha1.length) {
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(subtleText)
        .text(linha1.join(' | '), { align: 'center' });
    }
    if (linha2.length) {
      doc
        .moveDown(0.15)
        .fontSize(9)
        .fillColor(subtleText)
        .text(linha2.join(' | '), { align: 'center' });
    }

    doc.moveDown(0.8);

    const addSection = (titulo) => {
      doc
        .font('Helvetica-Bold')
        .fontSize(11)
        .fillColor(primaryColor)
        .text(titulo.toUpperCase() + ':', { align: 'left' });
      doc.moveDown(0.2);
      doc
        .moveTo(doc.page.margins.left, doc.y)
        .lineTo(doc.page.width - doc.page.margins.right, doc.y)
        .lineWidth(0.5)
        .strokeColor('#9CA3AF')
        .stroke();
      doc.moveDown(0.4);
      doc.font('Helvetica').fontSize(9).fillColor(primaryColor);
    };

    // Objetivo
    if (objetivo?.texto) {
      addSection('Objetivo');
      doc.text(objetivo.texto, { align: 'justify' });
      doc.moveDown(0.8);
    }

    // Formação acadêmica
    if (Array.isArray(formacao) && formacao.length) {
      addSection('Formação Acadêmica');
      formacao.forEach((f) => {
        if (!f.curso && !f.instituicao) return;

        const periodo =
          f.inicio || f.fim
            ? [f.inicio, f.fim].filter(Boolean).join(' - ')
            : '';

        doc
          .font('Helvetica-Bold')
          .fontSize(9)
          .text('• ' + (f.curso || ''), { align: 'left' });

        let linha = '';
        if (f.instituicao) linha += f.instituicao;
        if (periodo) linha += (linha ? ' — ' : '') + periodo;

        if (linha) {
          doc
            .moveDown(0.1)
            .font('Helvetica')
            .fontSize(9)
            .fillColor(subtleText)
            .text(linha, { align: 'left' })
            .fillColor(primaryColor);
        }

        doc.moveDown(0.4);
      });
    }

    // Habilidades e competências
    if (Array.isArray(habilidades) && habilidades.length) {
      addSection('Habilidades e Competências');
      habilidades.forEach((h) => {
        doc.text('• ' + h, { align: 'left' });
      });
      doc.moveDown(0.6);
    }

    // Experiência profissional
    if (Array.isArray(experiencias) && experiencias.length) {
      addSection('Experiência Profissional');
      experiencias.forEach((exp) => {
        if (!exp.cargo && !exp.empresa) return;

        const periodo =
          exp.inicio || exp.fim
            ? [exp.inicio, exp.fim].filter(Boolean).join(' - ')
            : '';

        const tituloLinha = [exp.cargo, exp.empresa].filter(Boolean).join(' - ');
        if (tituloLinha) {
          doc
            .font('Helvetica-Bold')
            .fontSize(9)
            .fillColor(primaryColor)
            .text(tituloLinha, { align: 'left' });
        }

        const linha2 = [];
        if (exp.localidade) linha2.push(exp.localidade);
        if (periodo) linha2.push(periodo);

        if (linha2.length) {
          doc
            .moveDown(0.1)
            .font('Helvetica')
            .fontSize(9)
            .fillColor(subtleText)
            .text(linha2.join(' | '), { align: 'left' })
            .fillColor(primaryColor);
        }

        if (exp.descricao) {
          doc
            .moveDown(0.2)
            .font('Helvetica')
            .fontSize(9)
            .text(exp.descricao, { align: 'justify' });
        }

        doc.moveDown(0.6);
      });
    }

    // Cursos adicionais / informação complementar
    if (Array.isArray(cursos) && cursos.length) {
      addSection('Informação Complementar');
      cursos.forEach((c) => {
        if (!c.nome && !c.instituicao) return;
        const linha = [
          c.nome || '',
          c.instituicao || '',
          c.cargaHoraria ? `${c.cargaHoraria}h` : ''
        ]
          .filter(Boolean)
          .join(' — ');
        doc.text('• ' + linha, { align: 'left' });
      });
      doc.moveDown(0.6);
    }

    // Idiomas
    if (Array.isArray(idiomas) && idiomas.length) {
      addSection('Idiomas');
      idiomas.forEach((idioma) => {
        if (!idioma.nome) return;
        const linha = [
          idioma.nome,
          idioma.nivel ? `(${idioma.nivel})` : ''
        ]
          .filter(Boolean)
          .join(' ');
        doc.text('• ' + linha, { align: 'left' });
      });
      doc.moveDown(0.6);
    }
  }

  // =====================
  //  MODELO MODERNO
  // =====================
  function renderModern(
    doc,
    { dadosPessoais, objetivo, experiencias, formacao, habilidades, idiomas, cursos }
  ) {
    // cores inspiradas na segunda imagem
    const primaryColor = '#111827';
    const subtleTextColor = '#4B5563';
    const lineColor = '#E5E7EB';

    // Faixa vertical clara à esquerda
    doc.rect(0, 0, 120, doc.page.height).fill('#F5F7EB');
    doc.fillColor(primaryColor);

    const contentX = 140;
    const startY = 60;
    doc.x = contentX;
    doc.y = startY;

    const nome = dadosPessoais?.nome || '';
    let subTitulo = '';

    if (objetivo?.texto) {
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
      .text(nome || 'Nome Completo', { align: 'left' });

    if (subTitulo) {
      doc
        .moveDown(0.2)
        .font('Helvetica')
        .fontSize(11)
        .fillColor(subtleTextColor)
        .text(subTitulo, { align: 'left' });
    }

    doc.moveDown(0.8);

    // CONTATO
    const contatos = [];
    if (dadosPessoais?.email) contatos.push(`Email: ${dadosPessoais.email}`);
    if (dadosPessoais?.telefone)
      contatos.push(`Telefone: ${dadosPessoais.telefone}`);
    if (dadosPessoais?.cidade || dadosPessoais?.estado) {
      contatos.push(
        `Endereço: ${[dadosPessoais.cidade, dadosPessoais.estado]
          .filter(Boolean)
          .join(' / ')}`
      );
    }

    if (contatos.length) {
      doc
        .font('Helvetica-Bold')
        .fontSize(10)
        .fillColor(primaryColor)
        .text('CONTATO', { align: 'left' });

      doc.moveDown(0.2);
      doc.font('Helvetica').fontSize(9).fillColor(subtleTextColor);
      contatos.forEach((c) => doc.text(c, { align: 'left' }));

      if (dadosPessoais?.linkedin || dadosPessoais?.site) {
        const links = [dadosPessoais.linkedin, dadosPessoais.site]
          .filter(Boolean)
          .join('  ·  ');
        if (links) {
          doc.moveDown(0.1).text(links, { align: 'left' });
        }
      }

      doc.moveDown(0.8);
    }

    const addSectionTitle = (title) => {
      doc
        .moveDown(0.3)
        .font('Helvetica-Bold')
        .fontSize(11)
        .fillColor(primaryColor)
        .text(title.toUpperCase(), { align: 'left' });

      doc
        .moveDown(0.15)
        .moveTo(contentX, doc.y)
        .lineTo(doc.page.width - doc.page.margins.right, doc.y)
        .lineWidth(0.7)
        .strokeColor(lineColor)
        .stroke();

      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(9).fillColor(primaryColor);
    };

    // OBJETIVO
    if (objetivo?.texto) {
      addSectionTitle('Objetivo');
      doc.text(objetivo.texto, { align: 'left' });
      doc.moveDown(0.6);
    }

    // EXPERIÊNCIA
    if (Array.isArray(experiencias) && experiencias.length) {
      addSectionTitle('Experiência');
      experiencias.forEach((exp) => {
        if (!exp.cargo && !exp.empresa) return;

        const periodo =
          exp.inicio || exp.fim
            ? [exp.inicio, exp.fim].filter(Boolean).join(' - ')
            : '';

        doc
          .font('Helvetica-Bold')
          .fontSize(10)
          .text(exp.cargo || '', { align: 'left' });

        if (exp.empresa) {
          doc
            .moveDown(0.1)
            .font('Helvetica')
            .fontSize(9)
            .fillColor(subtleTextColor)
            .text(exp.empresa, { align: 'left' })
            .fillColor(primaryColor);
        }

        if (periodo || exp.localidade) {
          const linha = [periodo, exp.localidade].filter(Boolean).join('  ·  ');
          doc
            .moveDown(0.05)
            .font('Helvetica')
            .fontSize(8)
            .fillColor(subtleTextColor)
            .text(linha, { align: 'left' })
            .fillColor(primaryColor);
        }

        if (exp.descricao) {
          doc
            .moveDown(0.15)
            .font('Helvetica')
            .fontSize(9)
            .text(exp.descricao, { align: 'left' });
        }

        doc.moveDown(0.6);
      });
    }

    // EDUCAÇÃO (Formação)
    if (Array.isArray(formacao) && formacao.length) {
      addSectionTitle('Educação');
      formacao.forEach((f) => {
        if (!f.curso && !f.instituicao) return;

        const periodo =
          f.inicio || f.fim
            ? [f.inicio, f.fim].filter(Boolean).join(' - ')
            : '';

        doc
          .font('Helvetica-Bold')
          .fontSize(10)
          .text(f.curso || '', { align: 'left' });

        if (f.instituicao) {
          doc
            .moveDown(0.1)
            .font('Helvetica')
            .fontSize(9)
            .fillColor(subtleTextColor)
            .text(f.instituicao, { align: 'left' })
            .fillColor(primaryColor);
        }

        if (periodo) {
          doc
            .moveDown(0.05)
            .font('Helvetica')
            .fontSize(8)
            .fillColor(subtleTextColor)
            .text(periodo, { align: 'left' })
            .fillColor(primaryColor);
        }

        doc.moveDown(0.6);
      });
    }

    // HABILIDADES
    if (Array.isArray(habilidades) && habilidades.length) {
      addSectionTitle('Habilidades');
      habilidades.forEach((h) => {
        doc.text('• ' + h, { align: 'left' });
      });
      doc.moveDown(0.6);
    }

    // CURSOS
    if (Array.isArray(cursos) && cursos.length) {
      addSectionTitle('Cursos');
      cursos.forEach((c) => {
        if (!c.nome && !c.instituicao) return;
        const linha = [
          c.nome || '',
          c.instituicao || '',
          c.cargaHoraria ? `${c.cargaHoraria}h` : ''
        ]
          .filter(Boolean)
          .join(' — ');
        doc.text('• ' + linha, { align: 'left' });
      });
      doc.moveDown(0.6);
    }

    // IDIOMAS
    if (Array.isArray(idiomas) && idiomas.length) {
      addSectionTitle('Idiomas');
      idiomas.forEach((idioma) => {
        if (!idioma.nome) return;
        const linha = [
          idioma.nome,
          idioma.nivel ? `(${idioma.nivel})` : ''
        ]
          .filter(Boolean)
          .join(' ');
        doc.text('• ' + linha, { align: 'left' });
      });
      doc.moveDown(0.6);
    }
  }
});


// 10) ROTA DE IA PARA "Objetivo Profissional" (Groq ou OpenAI)
app.post('/api/ia/objetivo', async (req, res) => {
  try {
    const { resumoVaga, cargo, senioridade, area, experiencia, pontosFortes } = req.body;

    const prompt = `
Você é um assistente especializado em criar descrições de "Objetivo Profissional" curtas, claras e profissionais para currículos.

Gere um objetivo profissional em português, no máximo 3 linhas, com tom profissional, usando as informações abaixo (use apenas o que fizer sentido):

- Cargo desejado: ${cargo || 'Não informado'}
- Senioridade: ${senioridade || 'Não informado'}
- Área de atuação: ${area || 'Não informado'}
- Experiência resumida: ${experiencia || 'Não informado'}
- Pontos fortes / habilidades: ${pontosFortes || 'Não informado'}
- Resumo da vaga ou contexto: ${resumoVaga || 'Não informado'}

Regras:
- Escreva em primeira pessoa ("Busco...", "Atuar como...").
- Não use frases genéricas demais.
- Não repita muitas vezes o mesmo termo.
- Responda apenas com o texto do objetivo, sem explicações adicionais.
`;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: 'Você é um gerador de objetivos profissionais para currículos.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 200
    });

    const objetivoGerado = completion.choices[0]?.message?.content?.trim();

    if (!objetivoGerado) {
      return res.status(500).json({
        error: 'Não foi possível gerar o objetivo profissional.'
      });
    }

    res.json({
      success: true,
      objetivo: objetivoGerado
    });
  } catch (err) {
    console.error('Erro na rota /api/ia/objetivo (Groq):', err);
    res.status(500).json({
      error: 'Erro ao gerar objetivo profissional com IA.'
    });
  }
});

/**
 * 11) SPA / ROTA CATCH-ALL
 *     Mantém comportamento de servir index.html para rotas desconhecidas.
 */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/**
 * 12) HTTPS EM PRODUÇÃO
 *     Em produção, use um proxy (Nginx, Caddy, etc.) com HTTPS na frente.
 */
app.listen(PORT, () => {
  console.log(`Servidor rodando em ${FRONTEND_BASE_URL} (porta ${PORT})`);
});

