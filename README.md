# MyCurrículo

Gerador de currículos profissional com:

- Front-end em HTML + Tailwind (CDN).
- Back-end em Node.js + Express.
- Banco de dados MongoDB (via Mongoose).
- Pagamentos com Stripe Checkout (webhook para confirmação).
- Geração de PDF com PDFKit (2 templates: claro e escuro).
- Paywall real para download do PDF.
- Painel admin simples para listar pedidos.

## Estrutura

```bash
.
├─ server.js
├─ package.json
├─ .env.example
└─ public/
   ├─ index.html
   ├─ criador.html
   ├─ pagamento.html
   ├─ sobre.html
   ├─ suporte.html
   ├─ admin.html
   └─ js/
      └─ api.js
```

## Como rodar localmente

1. Instale as dependências:

```bash
npm install
```

2. Copie o arquivo `.env.example` para `.env` e preencha com seus dados:

```bash
cp .env.example .env
```

3. Rode o servidor em modo desenvolvimento:

```bash
npm run dev
```

4. Acesse:

- Front-end: http://localhost:3000
- Criador de currículo: http://localhost:3000/criador.html
- Pagamento: http://localhost:3000/pagamento.html?orderId=...
- Painel admin: http://localhost:3000/admin.html

## Variáveis de ambiente

Veja o arquivo `.env.example` para a lista completa:

- `MONGODB_URI` – conexão do MongoDB.
- `STRIPE_SECRET_KEY` – chave secreta da API Stripe.
- `STRIPE_WEBHOOK_SECRET` – segredo do webhook do Stripe.
- `FRONTEND_BASE_URL` – URL pública do front (ex.: https://seu-dominio.com).
- `ADMIN_TOKEN` – token simples para autenticação no painel admin.
- `PORT` – porta da aplicação Node (default: 3000).

## Webhook do Stripe

1. No painel do Stripe, crie um endpoint de webhook apontando para:

```text
POST https://seu-dominio.com/api/webhooks/stripe
```

2. Selecione pelo menos os eventos relacionados a pagamento, por exemplo:

- `checkout.session.completed`

3. Copie o `signing secret` e coloque em `STRIPE_WEBHOOK_SECRET` no `.env`.

## Deploy (Render / Railway / VPS)

### Render

- Crie um novo serviço "Web Service" a partir do repositório.
- Escolha **Node** como runtime.
- Configure o comando de start: `npm start`.
- Configure as variáveis de ambiente (a partir de `.env.example`).
- Certifique-se de que o serviço esteja em modo "Web" (HTTP) na porta 3000 (ou a variável padrão de Render).

### Railway

- Crie um novo projeto a partir do repositório.
- Configure o service como NodeJS.
- Configure as variáveis de ambiente.
- Defina o comando de start: `npm start`.
- Railway fornece HTTPS automaticamente no domínio do projeto.

### VPS (Ubuntu, por exemplo)

- Instale Node.js (v18+).
- Instale MongoDB ou use MongoDB Atlas.
- Clone o repositório, rode `npm install`.
- Configure o `.env`.
- Use um process manager como `pm2`:

```bash
pm2 start server.js --name curriculo-em-minutos
```

- Coloque um Nginx na frente com HTTPS (certbot + Let’s Encrypt) apontando para `http://localhost:3000`.

### Vercel

Este projeto é um servidor Express "full", com Stripe webhook. Vercel é melhor para aplicações serverless, então:

- Opção 1: hospede APENAS o front (pasta `public`) na Vercel.
- Opção 2: mantenha o backend (Node + Stripe + Mongo) em Render/Railway ou VPS.

Nesse caso:

- `FRONTEND_BASE_URL` deve ser a URL da Vercel (ex.: `https://seu-site.vercel.app`).
- No backend (Render/Railway/VPS), use essa mesma URL nas URLs de sucesso/cancelamento do Stripe.

## Painel Admin

- Acesse `/admin.html`.
- Informe o `ADMIN_TOKEN` configurado no backend.
- Clique em "Carregar pedidos" para ver a lista dos últimos pedidos (até 100).

---

Pronto! Com esse setup você tem um gerador de currículos moderno, com pagamento e PDF profissional, pronto para evoluir com novos templates e features.
