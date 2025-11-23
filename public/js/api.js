// /public/js/api.js

const API_BASE_URL =
  window.API_BASE_URL ||
  'http://localhost:3000'; // para rodar local com o backend local

async function createOrder(payload) {
  const res = await fetch(`${API_BASE}/api/create-order`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Erro ao criar pedido.');
  }
  return res.json();
}

async function getOrder(orderId) {
  const res = await fetch(`${API_BASE}/api/order/${orderId}`);
  if (!res.ok) throw new Error('Pedido não encontrado.');
  return res.json();
}

// Em produção, o pagamento real é feito pelo Stripe Checkout.
// Esta função pede ao backend para criar uma sessão e retorna a URL.
async function createCheckoutSession(orderId) {
  const res = await fetch(
    `${API_BASE}/api/order/${orderId}/checkout-session`,
    {
      method: 'POST'
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Erro ao criar sessão de pagamento.');
  }
  return res.json();
}

function downloadPdf(orderId) {
  window.location.href = `${API_BASE}/api/order/${orderId}/pdf`;
}
