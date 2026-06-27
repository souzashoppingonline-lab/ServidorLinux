/* API client — thin fetch wrapper */
'use strict';

const API = (() => {
  const BASE = '';

  async function request(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    };
    if (body !== undefined) opts.body = JSON.stringify(body);

    const res = await fetch(BASE + path, opts);

    if (res.status === 401) {
      location.href = '/login';
      throw new Error('Sessão expirada');
    }

    let data;
    try { data = await res.json(); } catch { data = {}; }

    if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
    return data;
  }

  return {
    get:  (path)        => request('GET',    path),
    post: (path, body)  => request('POST',   path, body),
    put:  (path, body)  => request('PUT',    path, body),
    del:  (path)        => request('DELETE', path),

    /* Convenience builders */
    me:        ()                 => request('GET', '/api/me'),
    stores:    ()                 => request('GET', '/api/stores'),
    dashboard: (storeId)          => request('GET', `/api/dashboard?storeId=${storeId}`),
    listings:  (storeId, p = {})  => request('GET', `/api/listings?storeId=${storeId}&status=${p.status||'active'}&limit=${p.limit||50}&offset=${p.offset||0}`),
    updateItem:(id, storeId, data) => request('PUT', `/api/listings?id=${id}`, { storeId, ...data }),
    orders:    (storeId, p = {})  => request('GET', `/api/orders?storeId=${storeId}&status=${p.status||''}&from=${p.from||''}&to=${p.to||''}&limit=${p.limit||50}&offset=${p.offset||0}`),
    questions: (storeId, p = {})  => request('GET', `/api/questions?storeId=${storeId}&status=${p.status||'UNANSWERED'}&limit=${p.limit||50}&offset=${p.offset||0}`),
    answer:    (question_id, text, storeId) => request('POST', '/api/questions/answer', { question_id, text, storeId }),
    metrics:   (storeId, days)    => request('GET', `/api/metrics?storeId=${storeId}&days=${days}`),
    messages:  (storeId, packId)  => request('GET', `/api/messages?storeId=${storeId}&packId=${packId}`),
    sendMsg:   (storeId, packId, text) => request('POST', '/api/messages', { storeId, packId, text }),
    logout:    ()                 => request('POST', '/api/logout'),
    removeStore: (id)             => request('DELETE', `/api/stores?id=${id}`),
  };
})();
