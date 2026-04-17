let cart = JSON.parse(localStorage.getItem('shc-cart')) || [];
const price = 29;

window.onload = () => updateUI();

function toggleTheme() {
    document.body.classList.toggle('dark-theme');
    document.body.classList.toggle('light-theme');
}

function addToCart(code) {
    if (!cart.includes(code)) {
        cart.push(code);
        localStorage.setItem('shc-cart', JSON.stringify(cart));
        updateUI();
    }
}

function removeFromCart(code) {
    cart = cart.filter(c => c !== code);
    localStorage.setItem('shc-cart', JSON.stringify(cart));
    updateUI();
    renderCart();
    if (cart.length === 0) closeCart();
}

function updateUI() {
    document.querySelectorAll('#shc-count').forEach(el => el.innerText = cart.length);
}

function openCart() {
    if (cart.length === 0) return alert("Select assignments first!");
    renderCart();
    document.getElementById('cartModal').style.display = 'block';
}

function closeCart() { document.getElementById('cartModal').style.display = 'none'; }

function renderCart() {
    const list = document.getElementById('cart-list');
    const total = document.getElementById('grand-total');
    total.innerText = cart.length * price;
    list.innerHTML = cart.map(item => `
        <div class="cart-row">
            <span>📚 ${item}</span>
            <i class="fas fa-trash-alt" style="color:#ef4444; cursor:pointer" onclick="removeFromCart('${item}')"></i>
        </div>
    `).join('');
}

function checkoutWA() {
    const msg = `Hi Student Help Club! Order:\n📚 Subjects: ${cart.join(", ")}\n💰 Total: ₹${cart.length * price}`;
    window.open(`https://wa.me/916202368003?text=${encodeURIComponent(msg)}`, '_blank');
}

function searchSubject() {
    let input = document.getElementById('subjectSearch').value.toUpperCase();
    let cards = document.getElementsByClassName('shc-item-card');
    for (let card of cards) {
        let code = card.getAttribute('data-code');
        card.style.display = code.includes(input) ? "block" : "none";
    }
}

function openLegal(type) {
    const pages = {
        privacy: { title: "Privacy Policy", content: "Hum data store nahi karte. Order WhatsApp par hote hain." },
        contact: { title: "Contact Us", content: "Email: studenthelpdeskofficial@gmail.com | WhatsApp: +91 6202368003" }
    };
    document.getElementById('legalTitle').innerText = pages[type].title;
    document.getElementById('legalContent').innerText = pages[type].content;
    document.getElementById('legalModal').style.display = 'block';
}
function closeLegal() { document.getElementById('legalModal').style.display = 'none'; }