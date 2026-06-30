/* ============================================================
   MKD SHOP — DONNÉES & LOGIQUE
   ============================================================ */

/* ---------- Connexion Supabase ---------- */
const SUPABASE_URL = 'https://zlritpvatedsgwolamof.supabase.co';
const SUPABASE_KEY = 'sb_publishable_9scVQ-1LtMU0MNSTgLsKXw_BrI5ZtlH';
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false } // le jeton admin n'est jamais écrit en localStorage, il vit uniquement en mémoire le temps de la session
});

const PRODUCTS_TABLE = 'products';
const CARTS_TABLE = 'carts';
const SETTINGS_TABLE = 'settings';
const SALE_SETTING_KEY = 'global_sale';

/* ---------- Identifiant de panier (cookie, pas de localStorage) ---------- */
function getCookie(name) {
  const match = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
  return match ? decodeURIComponent(match[2]) : null;
}
function setCookie(name, value, days) {
  const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)};expires=${expires};path=/;SameSite=Lax`;
}
function getCartSessionId() {
  let id = getCookie('mkd_cart_sid');
  if (!id) {
    id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('sid-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    setCookie('mkd_cart_sid', id, 180);
  }
  return id;
}

/* ---------- Conversion produit <-> ligne Supabase ---------- */
function productFromRow(r) {
  return {
    id: r.id,
    name: r.name,
    desc: r.description,
    category: r.category,
    price: r.price,
    onSale: r.on_sale,
    discount: r.discount,
    rating: r.rating,
    reviews: r.reviews,
    available: r.available,
    image: r.image,
    images: r.images || [],
    badge: r.badge
  };
}
function productToRow(p) {
  return {
    id: p.id,
    name: p.name,
    description: p.desc,
    category: p.category,
    price: p.price,
    on_sale: p.onSale,
    discount: p.discount,
    rating: p.rating,
    reviews: p.reviews,
    available: p.available,
    image: p.image,
    images: p.images || [],
    badge: p.badge
  };
}

const DEFAULT_CATEGORIES = ['Parfums', 'Vêtements', 'Voiles', 'Accessoires', 'Cosmétiques'];

// Produits de démarrage (modifiables ensuite par la propriétaire)
const DEFAULT_PRODUCTS = [
  {
    id: 'p1', name: 'Eau de Parfum Rose Dorée', category: 'Parfums',
    desc: 'Un parfum floral et sucré aux notes de rose et de vanille, pour une élégance toute en douceur.',
    price: 18000, onSale: false, discount: 0, rating: 5, reviews: 24, available: true,
    image: '', images: [], badge: 'bestseller'
  },
  {
    id: 'p2', name: 'Abaya Brodée Beige', category: 'Vêtements',
    desc: 'Abaya fluide et élégante, finitions brodées main, parfaite pour toutes occasions.',
    price: 32000, onSale: true, discount: 20, rating: 4.5, reviews: 16, available: true,
    image: '', images: [], badge: 'promo'
  },
  {
    id: 'p3', name: 'Hijab Soie Rose Poudré', category: 'Voiles',
    desc: 'Voile en soie douce et légère, drapé facile, coloris rose poudré intemporel.',
    price: 8500, onSale: false, discount: 0, rating: 4.8, reviews: 31, available: true,
    image: '', images: [], badge: 'new'
  },
  {
    id: 'p4', name: 'Sac à Main Doré Chic', category: 'Accessoires',
    desc: 'Sac à main élégant avec chaînette dorée, idéal pour sublimer toutes vos tenues.',
    price: 21000, onSale: false, discount: 0, rating: 4.6, reviews: 12, available: true,
    image: '', images: [], badge: ''
  },
  {
    id: 'p5', name: 'Rouge à Lèvres Nude Satiné', category: 'Cosmétiques',
    desc: 'Tenue longue durée, fini satiné, teinte nude flatteuse pour toutes les peaux.',
    price: 6000, onSale: false, discount: 0, rating: 4.7, reviews: 19, available: true,
    image: '', images: [], badge: ''
  },
  {
    id: 'p6', name: 'Robe Longue Voilage Rose', category: 'Vêtements',
    desc: 'Robe longue ample et légère, idéale pour l\'été, coloris rose tendre.',
    price: 25000, onSale: false, discount: 0, rating: 4.4, reviews: 9, available: false,
    image: '', images: [], badge: ''
  }
];

let PRODUCTS = [];
let CART = [];
let currentFilter = { category: 'all', maxPrice: 100000, minRating: 0, search: '' };
let adminMode = false;
let editingProductId = null;

/* ---------- Temps réel Supabase (synchro automatique entre appareils) ---------- */
function setupRealtimeSync() {
  // Écoute tous les changements (ajout / modification / suppression) sur la table produits
  supabaseClient
    .channel('realtime-products')
    .on('postgres_changes', { event: '*', schema: 'public', table: PRODUCTS_TABLE }, (payload) => {
      handleProductRealtimeChange(payload);
    })
    .subscribe();

  // Écoute aussi les changements des réglages (soldes globales)
  supabaseClient
    .channel('realtime-settings')
    .on('postgres_changes', { event: '*', schema: 'public', table: SETTINGS_TABLE }, (payload) => {
      const key = (payload.new && payload.new.key) || (payload.old && payload.old.key);
      if (key === SALE_SETTING_KEY) {
        loadGlobalSale();
      }
    })
    .subscribe();
}

function handleProductRealtimeChange(payload) {
  const { eventType, new: newRow, old: oldRow } = payload;

  if (eventType === 'DELETE') {
    // Un produit a été supprimé sur un autre appareil : on l'enlève ici aussi
    const deletedId = oldRow ? oldRow.id : null;
    if (deletedId) PRODUCTS = PRODUCTS.filter(p => p.id !== deletedId);
  } else if (eventType === 'INSERT') {
    // Nouveau produit ajouté ailleurs : on l'ajoute si on ne l'a pas déjà
    const product = productFromRow(newRow);
    if (!PRODUCTS.find(p => p.id === product.id)) PRODUCTS.unshift(product);
  } else if (eventType === 'UPDATE') {
    // Produit modifié ailleurs : on met à jour la version locale
    const product = productFromRow(newRow);
    const existing = PRODUCTS.find(p => p.id === product.id);
    if (existing) Object.assign(existing, product);
    else PRODUCTS.unshift(product);
  }

  // On rafraîchit l'affichage (catalogue, catégories, etc.) immédiatement
  applyFilters();
  renderCategoryList();
}

/* ---------- Stockage Supabase ---------- */
async function loadData() {
  try {
    const { data, error } = await supabaseClient
      .from(PRODUCTS_TABLE)
      .select('*')
      .order('created_at', { ascending: true });
    if (error) throw error;

    if (data && data.length) {
      PRODUCTS = data.map(productFromRow);
    } else {
      // Catalogue vide : on initialise Supabase avec les produits de démarrage
      PRODUCTS = DEFAULT_PRODUCTS.slice();
      await seedDefaultProducts(PRODUCTS);
    }
  } catch (e) {
    console.error('Erreur de chargement des produits depuis Supabase :', e);
    PRODUCTS = DEFAULT_PRODUCTS.slice();
  }

  CART = await loadCart();

  // Le mode propriétaire n'est plus mémorisé (sécurité) : il repart à zéro à chaque visite.
  adminMode = false;
}

async function seedDefaultProducts(list) {
  try {
    const rows = list.map(productToRow);
    const { error } = await supabaseClient.from(PRODUCTS_TABLE).insert(rows);
    if (error) throw error;
  } catch (e) {
    console.error('Erreur d\'initialisation du catalogue Supabase :', e);
  }
}

async function saveProducts() {
  // Conservée pour compatibilité : réécrit tout le catalogue (peu utilisée, voir
  // saveProduct()/deleteProduct() qui font des opérations ciblées plus efficaces).
  try {
    const rows = PRODUCTS.map(productToRow);
    const { error } = await supabaseClient.from(PRODUCTS_TABLE).upsert(rows);
    if (error) throw error;
  } catch (e) {
    console.error('Erreur de sauvegarde des produits Supabase :', e);
  }
}

async function loadCart() {
  const sid = getCartSessionId();
  try {
    const { data, error } = await supabaseClient
      .from(CARTS_TABLE)
      .select('items')
      .eq('session_id', sid)
      .maybeSingle();
    if (error) throw error;
    return (data && data.items) ? data.items : [];
  } catch (e) {
    console.error('Erreur de chargement du panier Supabase :', e);
    return [];
  }
}

async function saveCart() {
  const sid = getCartSessionId();
  try {
    const { error } = await supabaseClient
      .from(CARTS_TABLE)
      .upsert({ session_id: sid, items: CART, updated_at: new Date().toISOString() });
    if (error) throw error;
  } catch (e) {
    console.error('Erreur de sauvegarde du panier Supabase :', e);
  }
}

function getCategories() {
  const cats = new Set(DEFAULT_CATEGORIES);
  PRODUCTS.forEach(p => cats.add(p.category));
  return Array.from(cats);
}

/* ---------- Rendu étoiles ---------- */
function renderStars(rating) {
  const full = Math.floor(rating);
  const half = rating % 1 >= 0.5;
  let stars = '';
  for (let i = 0; i < full; i++) stars += '★';
  if (half) stars += '½';
  for (let i = Math.ceil(rating); i < 5; i++) stars += '<span style="color:var(--border)">★</span>';
  return stars;
}

/* ---------- Sidebar catégories ---------- */
function renderCategoryList() {
  const ul = document.getElementById('categoryList');
  const cats = getCategories();
  let html = `<li><a href="#" class="${currentFilter.category === 'all' ? 'active' : ''}" onclick="setCategory('all');return false;">Toutes les catégories <span class="count">${PRODUCTS.length}</span></a></li>`;
  cats.forEach(cat => {
    const count = PRODUCTS.filter(p => p.category === cat).length;
    if (count === 0 && !DEFAULT_CATEGORIES.includes(cat)) return;
    html += `<li><a href="#" class="${currentFilter.category === cat ? 'active' : ''}" onclick="setCategory('${escapeJs(cat)}');return false;">${escapeHtml(cat)} <span class="count">${count}</span></a></li>`;
  });
  ul.innerHTML = html;
}

function setCategory(cat) {
  currentFilter.category = cat;
  document.querySelectorAll('nav.main-nav a, .mobile-nav a').forEach(a => {
    a.classList.toggle('active', a.dataset.cat === cat);
  });
  applyFilters();
  document.getElementById('boutique').scrollIntoView({ behavior: 'smooth' });
}

function filterByRating(val) {
  currentFilter.minRating = val;
  applyFilters();
}

function resetFilters() {
  currentFilter = { category: 'all', maxPrice: 100000, minRating: 0, search: '' };
  document.getElementById('priceRange').value = 100000;
  document.getElementById('priceDisplay').textContent = "Jusqu'à 100 000 FCFA";
  document.getElementById('searchInput').value = '';
  applyFilters();
}

/* ---------- Filtrage + tri ---------- */
function applyFilters() {
  let list = PRODUCTS.filter(p => {
    if (currentFilter.category !== 'all' && p.category !== currentFilter.category) return false;
    if (getEffectivePrice(p) > currentFilter.maxPrice) return false;
    if (p.rating < currentFilter.minRating) return false;
    if (currentFilter.search) {
      const q = currentFilter.search.toLowerCase();
      if (!p.name.toLowerCase().includes(q) && !p.category.toLowerCase().includes(q) && !(p.desc || '').toLowerCase().includes(q)) return false;
    }
    return true;
  });
  applySort(list);
  renderCategoryList();
}

function getEffectivePrice(p) {
  if (p.onSale && p.discount > 0) return Math.round(p.price * (1 - p.discount / 100));
  return p.price;
}

function applySort(list) {
  const val = document.getElementById('sortSelect').value;
  list = [...list];
  if (val === 'Prix croissant') list.sort((a, b) => getEffectivePrice(a) - getEffectivePrice(b));
  else if (val === 'Prix décroissant') list.sort((a, b) => getEffectivePrice(b) - getEffectivePrice(a));
  else if (val === 'Mieux notés') list.sort((a, b) => b.rating - a.rating);
  else if (val === 'Nouveautés') list.sort((a, b) => (b.id > a.id ? 1 : -1));
  else if (val === 'Nom A–Z') list.sort((a, b) => a.name.localeCompare(b.name));
  renderProducts(list);
}

/* ---------- Rendu grille produits ---------- */
function renderProducts(list) {
  const grid = document.getElementById('productsGrid');
  grid.innerHTML = '';
  if (adminMode) grid.classList.add('admin-mode'); else grid.classList.remove('admin-mode');

  if (list.length === 0) {
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:60px 0;color:var(--muted);font-family:'Jost',sans-serif;">Aucun produit ne correspond à votre recherche.</div>`;
    document.getElementById('resultCount').textContent = '0';
    return;
  }

  list.forEach((p, idx) => {
    const effPrice = getEffectivePrice(p);
    const badgeMap = { bestseller: 'Bestseller', new: 'Nouveau', promo: 'Promo' };
    const badgeHtml = p.badge ? `<div class="product-badge badge-${p.badge}">${badgeMap[p.badge] || p.badge}</div>` : '';
    const discountHtml = (p.onSale && p.discount > 0) ? `<div class="discount-tag">-${p.discount}%</div>` : '';
    const oldPriceHtml = (p.onSale && p.discount > 0) ? `<span class="product-old-price">${p.price.toLocaleString('fr-FR')} FCFA</span>` : '';
    const imgHtml = p.image
      ? `<img src="${p.image}" alt="${escapeHtml(p.name)}" loading="lazy">`
      : `<div class="no-img">🌸</div>`;

    const card = document.createElement('article');
    card.className = 'product-card';
    card.style.animationDelay = (idx % 20) * 0.04 + 's';
    card.setAttribute('itemscope', '');
    card.setAttribute('itemtype', 'https://schema.org/Product');
    card.onclick = function(e) {
      if (e.target.closest('button')) return;
      openProductDetail(p.id);
    };

    card.innerHTML = `
      <div class="product-image">
        ${imgHtml}
        ${badgeHtml}
        ${discountHtml}
        <button class="admin-edit-btn" title="Modifier" onclick="event.stopPropagation();openProductModal('${p.id}')">✎</button>
        <button class="admin-delete-btn" title="Supprimer" onclick="event.stopPropagation();deleteProduct('${p.id}')">🗑️</button>
      </div>
      <div class="product-info">
        <div class="product-category" itemprop="category">${escapeHtml(p.category)}</div>
        <h3 class="product-name" itemprop="name">${escapeHtml(p.name)}</h3>
        <p class="product-desc" itemprop="description">${escapeHtml(p.desc || '')}</p>
        <div class="product-rating" itemprop="aggregateRating" itemscope itemtype="https://schema.org/AggregateRating">
          <meta itemprop="ratingValue" content="${p.rating}">
          <meta itemprop="reviewCount" content="${p.reviews || 0}">
          <span class="stars">${renderStars(p.rating)}</span>
          <span class="count">(${p.reviews || 0})</span>
        </div>
        <div class="product-price-row" itemprop="offers" itemscope itemtype="https://schema.org/Offer">
          <meta itemprop="priceCurrency" content="XOF">
          <meta itemprop="price" content="${effPrice}">
          <meta itemprop="availability" content="${p.available ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock'}">
          <span class="product-price">${effPrice.toLocaleString('fr-FR')} FCFA</span>
          ${oldPriceHtml}
        </div>
        <div class="product-stock ${p.available ? 'stock-in' : 'stock-out'}">${p.available ? '✓ En stock' : '✗ Épuisé'}</div>
        <button class="add-to-cart-btn" ${!p.available ? 'disabled' : ''} onclick="event.stopPropagation();addToCart('${p.id}')">${p.available ? 'Ajouter au panier' : 'Indisponible'}</button>
      </div>
    `;
    grid.appendChild(card);
  });

  document.getElementById('resultCount').textContent = list.length;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}
function escapeJs(str) {
  return (str || '').replace(/'/g, "\\'");
}

/* ---------- Vue grille/liste ---------- */
function setView(mode) {
  const grid = document.getElementById('productsGrid');
  if (mode === 'list') {
    grid.className = 'products-grid list-view' + (adminMode ? ' admin-mode' : '');
    document.getElementById('listBtn').classList.add('active');
    document.getElementById('gridBtn').classList.remove('active');
  } else {
    grid.className = 'products-grid grid-view' + (adminMode ? ' admin-mode' : '');
    document.getElementById('gridBtn').classList.add('active');
    document.getElementById('listBtn').classList.remove('active');
  }
}

/* ============================================================
   MODE ADMIN (PROPRIÉTAIRE)
   ============================================================ */
function handleLogoClick(e) {
  e.preventDefault();
  if (adminMode) {
    // Déjà connecté : un nouveau clic sur le logo déconnecte réellement la session admin
    adminLogout();
  } else {
    openAdminLoginModal();
  }
}

function openAdminLoginModal() {
  document.getElementById('adminLoginForm').reset();
  document.getElementById('adminLoginError').style.display = 'none';
  document.getElementById('adminLoginModalOverlay').classList.add('open');
  setTimeout(() => document.getElementById('adminLoginName').focus(), 50);
}
function closeAdminLoginModal() {
  document.getElementById('adminLoginModalOverlay').classList.remove('open');
}

async function submitAdminLogin(e) {
  e.preventDefault();
  const email = document.getElementById('adminLoginName').value.trim();
  const password = document.getElementById('adminLoginCode').value;
  const errEl = document.getElementById('adminLoginError');
  errEl.style.display = 'none';
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    errEl.textContent = 'Email ou mot de passe incorrect.';
    errEl.style.display = 'block';
    return;
  }
  adminMode = true;
  closeAdminLoginModal();
  updateAdminUI();
  applyFilters();
}

async function adminLogout() {
  await supabaseClient.auth.signOut();
  adminMode = false;
  updateAdminUI();
  applyFilters();
}

function updateAdminUI() {
  document.getElementById('adminBanner').classList.toggle('active', adminMode);
}

/* ---------- Modal Produit (ajout / édition) ---------- */
function populateCategorySelect() {
  const sel = document.getElementById('productCategorySelect');
  sel.innerHTML = '';
  getCategories().forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    sel.appendChild(opt);
  });
}

function toggleNewCategory() {
  const input = document.getElementById('newCategoryInput');
  input.style.display = input.style.display === 'none' ? 'block' : 'none';
  if (input.style.display === 'block') input.focus();
}

let tempImages = []; // tableau de data URLs pour la galerie en cours d'édition

function previewProductImage(e) {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  let pending = files.length;
  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = function(ev) {
      tempImages.push(ev.target.result);
      pending--;
      renderImgGalleryPreview();
    };
    reader.readAsDataURL(file);
  });
  e.target.value = '';
}

function renderImgGalleryPreview() {
  const wrap = document.getElementById('imgGalleryPreview');
  wrap.innerHTML = '';
  tempImages.forEach((src, i) => {
    const div = document.createElement('div');
    div.className = 'gallery-thumb-wrap' + (i === 0 ? ' main' : '');
    div.innerHTML = `
      <img src="${src}">
      ${i === 0 ? '<span class="main-tag">Principale</span>' : ''}
      <button type="button" class="remove-thumb" onclick="removeTempImage(${i})">✕</button>
    `;
    wrap.appendChild(div);
  });
}

function removeTempImage(i) {
  tempImages.splice(i, 1);
  renderImgGalleryPreview();
}

function setStarInput(val) {
  document.getElementById('productRating').value = val;
  document.querySelectorAll('#starInput span').forEach(s => {
    s.classList.toggle('filled', parseInt(s.dataset.val) <= val);
  });
}

document.addEventListener('DOMContentLoaded', function() {
  document.querySelectorAll('#starInput span').forEach(s => {
    s.addEventListener('click', () => setStarInput(parseInt(s.dataset.val)));
  });
});

function toggleSaleFields() {
  const on = document.getElementById('productOnSale').checked;
  document.getElementById('saleFields').style.display = on ? 'block' : 'none';
  updateOldPricePreview();
}

function updateOldPricePreview() {
  const price = parseFloat(document.getElementById('productPrice').value) || 0;
  const discount = parseFloat(document.getElementById('productDiscount').value) || 0;
  document.getElementById('productOldPricePreview').value = price ? price.toLocaleString('fr-FR') + ' FCFA' : '—';
}

function openProductModal(id) {
  populateCategorySelect();
  editingProductId = id || null;
  tempImages = [];
  document.getElementById('newCategoryInput').style.display = 'none';
  document.getElementById('newCategoryInput').value = '';

  if (id) {
    const p = PRODUCTS.find(x => x.id === id);
    document.getElementById('productModalTitle').textContent = 'Modifier le produit';
    document.getElementById('productId').value = p.id;
    document.getElementById('productName').value = p.name;
    document.getElementById('productDesc').value = p.desc || '';
    document.getElementById('productCategorySelect').value = p.category;
    document.getElementById('productPrice').value = p.price;
    document.getElementById('productStock').value = p.available ? 'true' : 'false';
    setStarInput(p.rating);
    document.getElementById('productOnSale').checked = !!p.onSale;
    document.getElementById('productDiscount').value = p.discount || '';
    toggleSaleFields();
    tempImages = getProductImages(p).slice();
    renderImgGalleryPreview();
  } else {
    document.getElementById('productModalTitle').textContent = 'Ajouter un produit';
    document.getElementById('productForm').reset();
    document.getElementById('productId').value = '';
    setStarInput(5);
    document.getElementById('saleFields').style.display = 'none';
    renderImgGalleryPreview();
  }
  document.getElementById('productModalOverlay').classList.add('open');
}

function closeProductModal() {
  document.getElementById('productModalOverlay').classList.remove('open');
}

function getProductImages(p) {
  if (p.images && p.images.length) return p.images;
  if (p.image) return [p.image];
  return [];
}

async function saveProduct(e) {
  e.preventDefault();
  let category = document.getElementById('productCategorySelect').value;
  const newCat = document.getElementById('newCategoryInput').value.trim();
  if (document.getElementById('newCategoryInput').style.display !== 'none' && newCat) {
    category = newCat;
  }

  const id = document.getElementById('productId').value || ('p' + Date.now());
  const price = parseFloat(document.getElementById('productPrice').value) || 0;
  const onSale = document.getElementById('productOnSale').checked;
  const discount = onSale ? (parseFloat(document.getElementById('productDiscount').value) || 0) : 0;

  const existing = PRODUCTS.find(p => p.id === id);
  const images = tempImages.length ? tempImages.slice() : (existing ? getProductImages(existing) : []);
  const productData = {
    id,
    name: document.getElementById('productName').value.trim(),
    desc: document.getElementById('productDesc').value.trim(),
    category,
    price,
    onSale,
    discount,
    rating: parseFloat(document.getElementById('productRating').value) || 5,
    reviews: existing ? existing.reviews : 0,
    available: document.getElementById('productStock').value === 'true',
    image: images[0] || '',
    images,
    badge: onSale ? 'promo' : (existing ? existing.badge : '')
  };

  if (existing) {
    Object.assign(existing, productData);
  } else {
    PRODUCTS.unshift(productData);
  }

  closeProductModal();
  applyFilters();

  try {
    const { error } = await supabaseClient.from(PRODUCTS_TABLE).upsert(productToRow(productData));
    if (error) throw error;
  } catch (err) {
    console.error('Erreur de sauvegarde du produit Supabase :', err);
    alert('Le produit a été enregistré ici, mais la synchronisation en ligne a échoué. Vérifiez votre connexion internet.');
  }
}

async function deleteProduct(id) {
  if (!confirm('Supprimer définitivement ce produit ?')) return;
  PRODUCTS = PRODUCTS.filter(p => p.id !== id);
  applyFilters();
  try {
    const { error } = await supabaseClient.from(PRODUCTS_TABLE).delete().eq('id', id);
    if (error) throw error;
  } catch (err) {
    console.error('Erreur de suppression du produit Supabase :', err);
    alert('Le produit a été supprimé ici, mais la suppression en ligne a échoué. Vérifiez votre connexion internet.');
  }
}

/* ---------- Bannière soldes globale ---------- */
async function fetchGlobalSale() {
  try {
    const { data, error } = await supabaseClient
      .from(SETTINGS_TABLE)
      .select('value')
      .eq('key', SALE_SETTING_KEY)
      .maybeSingle();
    if (error) throw error;
    return (data && data.value) ? data.value : { active: false, text: '-20%' };
  } catch (e) {
    console.error('Erreur de chargement de la promo globale Supabase :', e);
    return { active: false, text: '-20%' };
  }
}

async function loadGlobalSale() {
  const sale = await fetchGlobalSale();
  if (sale.active) {
    document.getElementById('saleBanner').classList.add('active');
    document.getElementById('salePct').textContent = sale.text || '-20%';
  }
}

async function openGlobalSaleModal() {
  const sale = await fetchGlobalSale();
  document.getElementById('globalSaleToggle').checked = !!sale.active;
  document.getElementById('globalSaleText').value = sale.text || '-20%';
  document.getElementById('globalSaleModalOverlay').classList.add('open');
}
function closeGlobalSaleModal() {
  document.getElementById('globalSaleModalOverlay').classList.remove('open');
}
async function saveGlobalSale() {
  const active = document.getElementById('globalSaleToggle').checked;
  const text = document.getElementById('globalSaleText').value.trim() || '-20%';
  document.getElementById('saleBanner').classList.toggle('active', active);
  document.getElementById('salePct').textContent = text;
  closeGlobalSaleModal();

  try {
    const { error } = await supabaseClient
      .from(SETTINGS_TABLE)
      .upsert({ key: SALE_SETTING_KEY, value: { active, text } });
    if (error) throw error;
  } catch (e) {
    console.error('Erreur de sauvegarde de la promo globale Supabase :', e);
    alert('La promo a été appliquée ici, mais la sauvegarde en ligne a échoué. Vérifiez votre connexion internet.');
  }
}

/* ============================================================
   FICHE PRODUIT DÉTAILLÉE (clic sur un article, façon Jumia)
   ============================================================ */
let currentDetailProduct = null;
let currentDetailImageIndex = 0;
let currentDetailQty = 1;

function openProductDetail(id) {
  const p = PRODUCTS.find(x => x.id === id);
  if (!p) return;
  currentDetailProduct = p;
  currentDetailImageIndex = 0;
  currentDetailQty = 1;
  renderProductDetail();
  document.getElementById('productDetailOverlay').classList.add('open');
  // Reflète le produit consulté dans l'URL pour un partage direct
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('produit', id);
    history.replaceState(null, '', url.toString());
  } catch (e) {}
}

function closeProductDetail() {
  document.getElementById('productDetailOverlay').classList.remove('open');
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('produit');
    history.replaceState(null, '', url.toString());
  } catch (e) {}
}

function setDetailImage(i) {
  currentDetailImageIndex = i;
  renderProductDetail();
}

function changeDetailQty(delta) {
  currentDetailQty = Math.max(1, currentDetailQty + delta);
  renderProductDetail();
}

function renderProductDetail() {
  const p = currentDetailProduct;
  if (!p) return;
  const images = getProductImages(p);
  const effPrice = getEffectivePrice(p);
  const badgeMap = { bestseller: 'Bestseller', new: 'Nouveau', promo: 'Promo' };
  const badgeHtml = p.badge ? `<div class="product-badge badge-${p.badge}">${badgeMap[p.badge] || p.badge}</div>` : '';
  const discountHtml = (p.onSale && p.discount > 0) ? `<div class="discount-tag">-${p.discount}%</div>` : '';

  const mainImg = images[currentDetailImageIndex] || images[0];
  const mainImgHtml = mainImg
    ? `<img src="${mainImg}" alt="${escapeHtml(p.name)}">`
    : `<div class="no-img">🌸</div>`;

  let thumbsHtml = '';
  images.forEach((src, i) => {
    thumbsHtml += `<div class="pd-thumb ${i === currentDetailImageIndex ? 'active' : ''}" onclick="setDetailImage(${i})"><img src="${src}"></div>`;
  });
  if (adminMode) {
    thumbsHtml += `<div class="pd-thumb-add" title="Ajouter une photo" onclick="addDetailImage()">+</div>`;
  }

  const oldPriceHtml = (p.onSale && p.discount > 0)
    ? `<span class="pd-old-price">${p.price.toLocaleString('fr-FR')} FCFA</span><span class="pd-discount-pill">-${p.discount}%</span>`
    : '';

  const grid = document.getElementById('productDetailGrid');
  grid.innerHTML = `
    <div class="pd-gallery">
      <div class="pd-main-image">
        ${mainImgHtml}
        ${badgeHtml}
        ${discountHtml}
      </div>
      ${(images.length > 0 || adminMode) ? `<div class="pd-thumbs">${thumbsHtml}</div>` : ''}
    </div>
    <div class="pd-info">
      <div class="product-category">${escapeHtml(p.category)}</div>
      <h2 class="pd-title">${escapeHtml(p.name)}</h2>
      <div class="product-rating">
        <span class="stars">${renderStars(p.rating)}</span>
        <span class="count">(${p.reviews || 0} avis)</span>
      </div>
      <div class="pd-price-row">
        <span class="pd-price">${effPrice.toLocaleString('fr-FR')} FCFA</span>
        ${oldPriceHtml}
      </div>
      <div class="product-stock ${p.available ? 'stock-in' : 'stock-out'}">${p.available ? '✓ En stock' : '✗ Épuisé'}</div>
      <div class="pd-desc-block">
        <h4>Description</h4>
        <p>${escapeHtml(p.desc || 'Aucune description disponible pour ce produit.')}</p>
      </div>
      <div class="pd-qty-row">
        <span style="font-family:'Jost',sans-serif;font-size:0.78rem;color:var(--muted);">Quantité</span>
        <div class="qty-controls">
          <button type="button" onclick="changeDetailQty(-1)">−</button>
          <span>${currentDetailQty}</span>
          <button type="button" onclick="changeDetailQty(1)">+</button>
        </div>
      </div>
      <div class="pd-actions">
        <button class="add-to-cart-btn" ${!p.available ? 'disabled' : ''} onclick="addToCartFromDetail()">${p.available ? 'Ajouter au panier' : 'Indisponible'}</button>
        <button class="pd-share-btn" title="Partager ce produit" onclick="shareProduct()">🔗</button>
      </div>
    </div>
    ${renderRelatedProductsHtml(p)}
  `;
}

function renderRelatedProductsHtml(p) {
  // Produits de la même catégorie, hors produit courant, limités à 4
  let related = PRODUCTS.filter(x => x.id !== p.id && x.category === p.category);
  // Si pas assez de produits dans la même catégorie, on complète avec d'autres produits
  if (related.length < 4) {
    const others = PRODUCTS.filter(x => x.id !== p.id && x.category !== p.category);
    related = related.concat(others.slice(0, 4 - related.length));
  }
  related = related.slice(0, 4);
  if (related.length === 0) return '';

  let cardsHtml = '';
  related.forEach(rp => {
    const rImages = getProductImages(rp);
    const rImg = rImages[0];
    const rImgHtml = rImg ? `<img src="${rImg}" alt="${escapeHtml(rp.name)}">` : `<div class="no-img">🌸</div>`;
    const rPrice = getEffectivePrice(rp);
    cardsHtml += `
      <div class="pd-related-card" onclick="openProductDetail('${rp.id}')">
        <div class="pd-related-img">${rImgHtml}</div>
        <div class="pd-related-info">
          <div class="pd-related-name">${escapeHtml(rp.name)}</div>
          <div class="pd-related-price">${rPrice.toLocaleString('fr-FR')} FCFA</div>
        </div>
      </div>
    `;
  });

  return `
    <div class="pd-related-section">
      <h3>Vous aimerez aussi</h3>
      <div class="pd-related-grid">${cardsHtml}</div>
    </div>
  `;
}

function addToCartFromDetail() {
  const p = currentDetailProduct;
  if (!p || !p.available) return;
  const existing = CART.find(c => c.id === p.id);
  if (existing) existing.qty += currentDetailQty;
  else CART.push({ id: p.id, name: p.name, price: getEffectivePrice(p), image: p.image, qty: currentDetailQty });
  saveCart();
  updateCartBadge();
  closeProductDetail();
  openCart();
}

function addDetailImage() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.onchange = function(e) {
    const files = Array.from(e.target.files || []);
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = async function(ev) {
        const images = getProductImages(currentDetailProduct);
        images.push(ev.target.result);
        currentDetailProduct.image = images[0];
        currentDetailProduct.images = images;
        renderProductDetail();
        try {
          const { error } = await supabaseClient.from(PRODUCTS_TABLE).upsert(productToRow(currentDetailProduct));
          if (error) throw error;
        } catch (err) {
          console.error('Erreur de sauvegarde de l\'image produit Supabase :', err);
        }
      };
      reader.readAsDataURL(file);
    });
  };
  input.click();
}

function shareProduct() {
  const p = currentDetailProduct;
  if (!p) return;
  const url = new URL(window.location.href);
  url.searchParams.set('produit', p.id);
  const shareUrl = url.toString();
  const effPrice = getEffectivePrice(p);
  const shareText = `${p.name} — ${effPrice.toLocaleString('fr-FR')} FCFA sur MKD Shop`;

  if (navigator.share) {
    navigator.share({ title: p.name, text: shareText, url: shareUrl }).catch(() => {});
  } else {
    const tempInput = document.createElement('textarea');
    tempInput.value = shareUrl;
    document.body.appendChild(tempInput);
    tempInput.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(tempInput);
    showShareToast();
  }
}

function showShareToast() {
  const toast = document.getElementById('pdShareToast');
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2200);
}

// Ouvre directement la fiche produit si l'URL contient ?produit=ID (lien partagé)
function checkSharedProductLink() {
  try {
    const url = new URL(window.location.href);
    const id = url.searchParams.get('produit');
    if (id && PRODUCTS.find(p => p.id === id)) {
      openProductDetail(id);
    }
  } catch (e) {}
}

/* ============================================================
   PANIER
   ============================================================ */
function addToCart(id) {
  const p = PRODUCTS.find(x => x.id === id);
  if (!p || !p.available) return;
  const existing = CART.find(c => c.id === id);
  if (existing) existing.qty += 1;
  else CART.push({ id: p.id, name: p.name, price: getEffectivePrice(p), image: p.image, qty: 1 });
  saveCart();
  updateCartBadge();
}

function updateCartBadge() {
  const badge = document.getElementById('cartBadge');
  const total = CART.reduce((sum, c) => sum + c.qty, 0);
  if (total > 0) {
    badge.style.display = 'flex';
    badge.textContent = total;
  } else {
    badge.style.display = 'none';
  }
}

function openCart() {
  renderCart();
  document.getElementById('cartModalOverlay').classList.add('open');
}
function closeCart() {
  document.getElementById('cartModalOverlay').classList.remove('open');
}

function renderCart() {
  const wrap = document.getElementById('cartItemsWrap');
  if (CART.length === 0) {
    wrap.innerHTML = `<div class="empty-cart">Votre panier est vide pour le moment.</div>`;
    document.getElementById('cartTotalWrap').style.display = 'none';
    document.getElementById('cartCheckoutWrap').style.display = 'none';
    return;
  }
  let html = '';
  let total = 0;
  CART.forEach(c => {
    total += c.price * c.qty;
    const imgHtml = c.image ? `<img src="${c.image}" alt="${escapeHtml(c.name)}">` : `<div style="width:64px;height:64px;border-radius:10px;background:var(--cream-dark);display:flex;align-items:center;justify-content:center;font-size:1.4rem;">🌸</div>`;
    html += `
      <div class="cart-item">
        ${imgHtml}
        <div class="cart-item-info">
          <div class="cart-item-name">${escapeHtml(c.name)}</div>
          <div class="cart-item-price">${c.price.toLocaleString('fr-FR')} FCFA</div>
        </div>
        <div class="qty-controls">
          <button onclick="changeQty('${c.id}', -1)">−</button>
          <span>${c.qty}</span>
          <button onclick="changeQty('${c.id}', 1)">+</button>
        </div>
        <button class="remove-btn" onclick="removeFromCart('${c.id}')">✕</button>
      </div>
    `;
  });
  wrap.innerHTML = html;
  document.getElementById('cartTotalWrap').style.display = 'flex';
  document.getElementById('cartTotalAmount').textContent = total.toLocaleString('fr-FR') + ' FCFA';
  document.getElementById('cartCheckoutWrap').style.display = 'flex';
}

function changeQty(id, delta) {
  const item = CART.find(c => c.id === id);
  if (!item) return;
  item.qty += delta;
  if (item.qty <= 0) CART = CART.filter(c => c.id !== id);
  saveCart();
  updateCartBadge();
  renderCart();
}
function removeFromCart(id) {
  CART = CART.filter(c => c.id !== id);
  saveCart();
  updateCartBadge();
  renderCart();
}

/* ============================================================
   RECHERCHE / TRI / NAVIGATION
   ============================================================ */
document.getElementById('sortSelect').addEventListener('change', applyFilters);

document.getElementById('searchInput').addEventListener('input', function() {
  currentFilter.search = this.value;
  applyFilters();
});

document.getElementById('priceRange').addEventListener('input', function() {
  const max = parseInt(this.value);
  currentFilter.maxPrice = max;
  document.getElementById('priceDisplay').textContent = `Jusqu'à ${max.toLocaleString('fr-FR')} FCFA`;
  applyFilters();
});

document.querySelectorAll('nav.main-nav a, footer a[data-cat], .hero-cat-pill').forEach(el => {
  el.addEventListener('click', function(e) {
    if (this.dataset.cat) {
      e.preventDefault();
      setCategory(this.dataset.cat);
    }
  });
});

function toggleMobileNav() {
  document.getElementById('hamburgerBtn').classList.toggle('open');
  document.getElementById('mobileNav').classList.toggle('open');
}

function mobileSearch() {
  const q = document.getElementById('searchInputMobile').value;
  document.getElementById('searchInput').value = q;
  currentFilter.search = q;
  applyFilters();
}

function openFilterDrawer() {
  document.getElementById('filterDrawer').classList.add('open');
  document.getElementById('sidebarOverlay').classList.add('open');
}
function closeFilterDrawer() {
  document.getElementById('filterDrawer').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('open');
}

/* ============================================================
   MKD : overlays dynamiques (chargement produits + commande WhatsApp)
   ============================================================ */
const MKD_WHATSAPP_NUMBER = '221784490039'; // même numéro que le bouton WhatsApp existant

/* ---- Loader produits (branché sur initApp/loadData) ---- */
const mkdLoaderEl = document.getElementById('mkdLoader');
const mkdBarEl = document.getElementById('mkdProgressBar');
let mkdLoaderAnim = null;

function showProductLoader() {
  mkdLoaderEl.hidden = false;
  let v = 8, dir = 1;
  mkdLoaderAnim = setInterval(() => {
    v += dir * 1.2;
    if (v >= 92) dir = -1;
    if (v <= 8) dir = 1;
    mkdBarEl.style.width = v + '%';
  }, 40);
}
function hideProductLoader() {
  clearInterval(mkdLoaderAnim);
  mkdBarEl.style.width = '100%';
  setTimeout(() => mkdLoaderEl.hidden = true, 250);
}

/* ---- Overlay commande WhatsApp : Commande → Préparation → Envoi (sans livraison) ---- */
const mkdOrderEl = document.getElementById('mkdOrder');
const mkdStepEls = mkdOrderEl.querySelectorAll('.mkd-step');
const mkdRecapEl = document.getElementById('mkdRecap');
const mkdOrderTitleEl = document.getElementById('mkdOrderTitle');
const mkdOrderSubEl = document.getElementById('mkdOrderSub');

function mkdFormatFCFA(n) {
  return n.toLocaleString('fr-FR') + ' FCFA';
}

function mkdBuildWhatsAppMessage(items, customer = {}) {
  const lines = ['Bonjour MKD Shop, je souhaite commander :', ''];
  if (customer.name) lines.push(`Client : ${customer.name}`, '');
  let total = 0;
  items.forEach(it => {
    const sub = it.qty * it.price;
    total += sub;
    lines.push(`- ${it.name} x${it.qty} (${mkdFormatFCFA(sub)})`);
  });
  lines.push('', `Total : ${mkdFormatFCFA(total)}`);
  if (customer.note) lines.push('', `Note : ${customer.note}`);
  return lines.join('\n');
}

/**
 * Lance l'animation de commande (préparation, sans livraison) puis ouvre WhatsApp.
 * @param {Array<{name:string, qty:number, price:number}>} items
 * @param {{name?:string, note?:string}} customer
 */
function sendOrderViaWhatsApp(items, customer = {}) {
  if (!items || !items.length) return;

  const totalQty = items.reduce((s, i) => s + i.qty, 0);
  const total = items.reduce((s, i) => s + i.qty * i.price, 0);
  mkdRecapEl.innerHTML = `<span>${totalQty} ARTICLE(S)</span><strong>${mkdFormatFCFA(total)}</strong>`;

  mkdStepEls.forEach(s => s.classList.remove('is-active', 'is-done'));
  mkdStepEls[0].classList.add('is-active');
  mkdOrderTitleEl.textContent = 'Votre commande est en cours…';
  mkdOrderSubEl.innerHTML = 'Nous préparons vos articles avec soin.<br>Veuillez patienter quelques instants.';
  mkdOrderEl.hidden = false;

  // Étape 1 → 2 (préparation de la commande)
  setTimeout(() => {
    mkdStepEls[0].classList.replace('is-active', 'is-done');
    mkdStepEls[1].classList.add('is-active');
    mkdOrderTitleEl.textContent = 'Préparation de votre commande…';
    mkdOrderSubEl.textContent = 'Vos articles sont rassemblés avec soin.';
  }, 1400);

  // Étape 2 → 3 (envoi WhatsApp)
  setTimeout(() => {
    mkdStepEls[1].classList.replace('is-active', 'is-done');
    mkdStepEls[2].classList.add('is-active');
  }, 2800);

  // Ouverture WhatsApp
  setTimeout(() => {
    const msg = mkdBuildWhatsAppMessage(items, customer);
    const url = `https://wa.me/${MKD_WHATSAPP_NUMBER}?text=${encodeURIComponent(msg)}`;
    window.open(url, '_blank');
    mkdStepEls[2].classList.replace('is-active', 'is-done');
    mkdOrderTitleEl.textContent = 'Commande envoyée 💕';
    mkdOrderSubEl.textContent = 'Nous vous retrouvons sur WhatsApp pour finaliser ensemble.';
  }, 3400);

  // Fermeture auto de l'overlay
  setTimeout(() => mkdOrderEl.hidden = true, 6500);
}

// Fermer l'overlay commande en cliquant à côté de la carte
mkdOrderEl.addEventListener('click', e => {
  if (e.target === mkdOrderEl) mkdOrderEl.hidden = true;
});

/* ---- Branché sur le bouton "Commander via WhatsApp" du panier ---- */
function launchCartOrder() {
  if (!CART || !CART.length) return;
  const items = CART.map(c => ({ name: c.name, qty: c.qty, price: c.price }));
  sendOrderViaWhatsApp(items);
}
/* ============================================================
   INIT
   ============================================================ */
async function initApp() {
  showProductLoader();
  try {
    await loadData();
  } finally {
    hideProductLoader();
  }
  await loadGlobalSale();
  updateCartBadge();
  applyFilters();
  checkSharedProductLink();
  setupRealtimeSync(); // active la synchronisation en temps réel entre tous les appareils
}
initApp();
