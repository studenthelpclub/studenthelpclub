// --- CONFIGURATION ---
const SHEET_ID = '1GU-HeNd18A64kDX-Hbfjwufksxy9OH3pFbRbW4nnfyY';
const TAB_NAME = 'Sheet1'; 
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${TAB_NAME}`;

let cart = JSON.parse(localStorage.getItem('shc-cart')) || [];
let allSubjects = []; 

// Initial Load
window.onload = () => {
    fetchSheetData();
    updateUI();
};

// --- DATA FETCHING ---
async function fetchSheetData() {
    try {
        const response = await fetch(CSV_URL);
        const data = await response.text();
        const rows = data.split('\n').slice(1); 
        allSubjects = rows.map(row => {
            const cols = row.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/); 
            return {
                code: cols[0]?.replace(/"/g, '').trim() || "N/A",
                name: cols[1]?.replace(/"/g, '').trim() || "Unknown Subject",
                course: cols[2]?.replace(/"/g, '').trim() || "General",
                year: cols[3]?.replace(/"/g, '').trim() || "2025-26",
                session: cols[4]?.replace(/"/g, '').trim() || "June & Jan",
                price: cols[5]?.replace(/"/g, '').trim() || "29"
            };
        });
        renderDynamicGrid(); 
    } catch (error) {
        console.error("Sheet load error:", error);
        const grid = document.getElementById('mainGrid');
        if(grid) grid.innerHTML = "<p style='color:red;'>Failed to load data. Please check internet.</p>";
    }
}

// --- RENDERING LOGIC ---
function renderDynamicGrid() {
    const grid = document.getElementById('mainGrid');
    const titleEl = document.getElementById('courseTitle');
    if (!grid) return;

    const urlParams = new URLSearchParams(window.location.search);
    const type = urlParams.get('type'); 
    if (titleEl && type) titleEl.innerText = `${type} Subjects (2025-26)`;

    const filtered = type ? allSubjects.filter(s => 
        s.course.replace(/\s+/g, '').toUpperCase().includes(type.toUpperCase())
    ) : allSubjects;
    
    if (filtered.length === 0) {
        grid.innerHTML = "<p style='grid-column:1/-1; text-align:center; padding:50px;'>No assignments found for this category.</p>";
        return;
    }

    grid.innerHTML = filtered.map(sub => `
        <div class="shc-item-card" id="card-${sub.code.replace(/\s+/g, '')}">
            <div class="card-tag">${sub.year}</div>
            <h3>${sub.code}</h3>
            <p>${sub.name}</p>
            <p style="font-size: 12px; color: #10b981; font-weight: bold; margin: 10px 0;">
                <i class="fas fa-calendar-check"></i> Valid for: ${sub.session} Session
            </p>
            <div class="selection-box" style="margin-top: 10px; display: flex; gap: 8px;">
                <select class="opt-medium" style="flex: 1; padding: 6px; border-radius: 8px; border: 1px solid #ddd; background: var(--card); color: var(--text);">
                    <option value="Hindi">Hindi</option>
                    <option value="English">English</option>
                </select>
                <select class="opt-session" style="flex: 1; padding: 6px; border-radius: 8px; border: 1px solid #ddd; background: var(--card); color: var(--text);">
                    <option value="${sub.year}">${sub.year}</option>
                </select>
            </div>
            <div class="card-footer" style="flex-direction: column; align-items: stretch; gap: 10px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span class="price-tag">₹${sub.price}</span>
                    <button class="add-btn" onclick="prepareAndAdd('${sub.code.replace(/\s+/g, '')}')">Add to Cart</button>
                </div>
                <button class="buy-btn" onclick="directBuy('${sub.code.replace(/\s+/g, '')}')" style="background: #22c55e; color: white; border: none; padding: 10px; border-radius: 10px; font-weight: bold; cursor: pointer; width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px;">
                    <i class="fab fa-whatsapp"></i> Buy Now
                </button>
            </div>
        </div>
    `).join('');
}

// --- UNIQUE ORDER ID ---
function generateOrderId() {
    const now = new Date();
    const datePart = now.getDate().toString().padStart(2, '0') + (now.getMonth() + 1).toString().padStart(2, '0');
    const timePart = now.getTime().toString().slice(-4);
    return `SHC-${datePart}-${timePart}`;
}

// --- TOAST NOTIFICATION ---
function showToast(text) {
    let x = document.getElementById("shc-toast");
    if(!x) {
        x = document.createElement("div");
        x.id = "shc-toast";
        document.body.appendChild(x);
    }
    x.innerText = text;
    x.className = "show";
    setTimeout(() => { x.className = x.className.replace("show", ""); }, 3000);
}

// --- CART LOGIC ---
function prepareAndAdd(subjectId) {
    const card = document.getElementById('card-' + subjectId);
    if (!card) return;
    const code = card.querySelector('h3').innerText;
    const medium = card.querySelector('.opt-medium').value;
    const session = card.querySelector('.opt-session').value;
    const priceText = card.querySelector('.price-tag').innerText;
    const priceValue = parseInt(priceText.replace(/[^0-9]/g, '')) || 29;
    
    addToCart({
        name: `${code} (${medium}) [${session}]`,
        code: code,
        price: priceValue
    });
}

function addToCart(item) {
    const exists = cart.some(c => c.name === item.name);
    if (!exists) {
        cart.push(item);
        localStorage.setItem('shc-cart', JSON.stringify(cart));
        updateUI();
        showToast("✅ Added: " + item.code);
    } else {
        showToast("⚠️ Already in selection!");
    }
}

// --- WHATSAPP MESSAGING ---
function checkoutWA() {
    if (cart.length === 0) return;
    const orderId = generateOrderId();
    const today = new Date().toLocaleDateString('en-IN');
    let total = cart.reduce((sum, item) => sum + item.price, 0);

    let msg = `*📦 OFFICIAL ORDER - STUDENT HELP CLUB*\n`;
    msg += `-----------------------------------\n`;
    msg += `*Invoice No:* #${orderId}\n`;
    msg += `*Date:* ${today}\n`;
    msg += `-----------------------------------\n\n`;
    msg += `*Items List:*\n`;
    msg += cart.map((i, idx) => `${idx+1}. ✅ ${i.name} - _₹${i.price}_`).join("\n");
    msg += `\n\n*GRAND TOTAL: ₹${total}*\n`;
    msg += `-----------------------------------\n`;
    msg += `_Hi Vishal, I want to buy these solved assignments. Please send me the payment details._`;

    window.open(`https://wa.me/919776986830?text=${encodeURIComponent(msg)}`, '_blank');

    // AUTO-CLEAR CART AFTER CHECKOUT
    setTimeout(() => {
        cart = [];
        localStorage.removeItem('shc-cart');
        updateUI();
        closeCart();
    }, 1500);
}

function directBuy(subjectId) {
    const card = document.getElementById('card-' + subjectId);
    if (!card) return;
    const orderId = generateOrderId();
    const code = card.querySelector('h3').innerText;
    const medium = card.querySelector('.opt-medium').value;
    const session = card.querySelector('.opt-session').value;
    const priceText = card.querySelector('.price-tag').innerText;
    const priceValue = priceText.replace(/[^0-9]/g, '') || "29";
    
    let msg = `*📦 QUICK PURCHASE - STUDENT HELP CLUB*\n`;
    msg += `-----------------------------------\n`;
    msg += `*Invoice:* #${orderId}\n`;
    msg += `*Subject:* ✅ ${code}\n`;
    msg += `*Medium:* ${medium}\n`;
    msg += `*Session:* ${session}\n`;
    msg += `*Price:* ₹${priceValue}\n`;
    msg += `-----------------------------------\n`;
    msg += `_Hi, I want to buy this single assignment. Please guide me for payment._`;

    window.open(`https://wa.me/919776986830?text=${encodeURIComponent(msg)}`, '_blank');
}

// --- MISC ---
function removeFromCart(index) {
    cart.splice(index, 1);
    localStorage.setItem('shc-cart', JSON.stringify(cart));
    updateUI();
    renderCart();
    if (cart.length === 0) closeCart();
}

function updateUI() {
    document.querySelectorAll('#shc-count').forEach(el => el.innerText = cart.length);
}

function renderCart() {
    const list = document.getElementById('cart-list');
    const totalEl = document.getElementById('grand-total');
    let total = cart.reduce((sum, item) => sum + item.price, 0);
    totalEl.innerText = total;

    list.innerHTML = cart.map((item, index) => `
        <div class="cart-row" style="display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid rgba(0,0,0,0.1); align-items: center;">
            <span style="font-size: 0.85rem; color: var(--text);">📚 ${item.name} (₹${item.price})</span>
            <i class="fas fa-trash-alt" style="color:#ef4444; cursor:pointer; padding:5px;" onclick="removeFromCart(${index})"></i>
        </div>
    `).join('');
}

function searchSubject() {
    let input = document.getElementById('headerSearch').value.toUpperCase();
    let resultsDiv = document.getElementById('search-results-dropdown');
    if (input.length < 2) { resultsDiv.style.display = "none"; return; }

    let filtered = allSubjects.filter(item => 
        item.code.toUpperCase().includes(input) || item.name.toUpperCase().includes(input)
    );
    
    if (filtered.length > 0) {
        resultsDiv.innerHTML = filtered.map(item => {
            const primaryCourse = item.course.split('/')[0].trim().replace(/\s+/g, '');
            return `
            <a href="course.html?type=${primaryCourse}" class="search-item">
                <strong>${item.code}</strong> - ${item.name} <br><small style="color:#666">Category: ${item.course}</small>
            </a>
        `}).join('');
        resultsDiv.style.display = "block";
    } else {
        resultsDiv.innerHTML = '<div class="search-item">Subject not found</div>';
        resultsDiv.style.display = "block";
    }
}

function openCart() { if (cart.length > 0) { renderCart(); document.getElementById('cartModal').style.display = 'block'; } else { showToast("🛒 Cart is empty!"); } }
function closeCart() { document.getElementById('cartModal').style.display = 'none'; }
function toggleTheme() {
    document.body.classList.toggle('dark-theme');
    const icon = document.querySelector('#theme-toggle i');
    if(document.body.classList.contains('dark-theme')) icon.classList.replace('fa-moon', 'fa-sun');
    else icon.classList.replace('fa-sun', 'fa-moon');
}
function openLegal(type) {
    const pages = {
        privacy: { title: "Privacy Policy", content: "Hum aapka koi bhi personal data store nahi karte. Saare orders direct WhatsApp par process hote hain safety ke liye." },
        contact: { title: "Contact Us", content: "WhatsApp: +91 9776986830\nTelegram: @studenthelpclub\nEmail: studenthelpdeskofficial@gmail.com\nWorking Hours: 10 AM - 8 PM" }
    };
    document.getElementById('legalTitle').innerText = pages[type].title;
    document.getElementById('legalContent').innerText = pages[type].content;
    document.getElementById('legalModal').style.display = 'block';
}
function closeLegal() { document.getElementById('legalModal').style.display = 'none'; }
window.onclick = (e) => { if (e.target.className === 'shc-modal') { closeCart(); closeLegal(); } };
// Floating WhatsApp Button Dynamic Injection
document.addEventListener("DOMContentLoaded", function() {
    var waButton = document.createElement('a');
    waButton.href = "https://wa.me/919999999999?text=Hello%20Student%20Help%20Club,%20mujhe%20assignments%20ke%20baare%20me%20puchna%20hai."; // <-- Apna number change karein
    waButton.className = "whatsapp-float";
    waButton.target = "_blank";
    waButton.rel = "noopener noreferrer";
    waButton.innerHTML = `
        <svg viewBox="0 0 24 24" class="whatsapp-icon" style="width:32px; height:32px; fill:#fff;">
            <path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946C.06 5.348 5.397 0 11.948 0c3.179.001 6.165 1.24 8.413 3.494 2.25 2.253 3.489 5.24 3.487 8.425-.004 6.599-5.342 11.947-11.893 11.947-1.997-.001-3.956-.5-5.694-1.448L0 24zm6.59-4.846c1.6.95 3.188 1.449 4.825 1.451 5.436 0 9.86-4.42 9.864-9.852.002-2.63-1.023-5.101-2.884-6.963C16.53 1.878 14.06 1.85 11.95 1.85c-5.438 0-9.863 4.42-9.866 9.853-.001 1.762.478 3.48 1.383 5.004L2.408 21.6l5.032-1.317zM17.76 14.77c-.317-.159-1.88-.928-2.172-1.034-.29-.105-.503-.159-.715.159-.211.318-.82.1.034-1.006.105-.185.212-.39.212-.607 0-.212-.105-.424-.212-.636-.106-.211-.715-1.74-.98-2.375-.256-.616-.517-.533-.715-.543-.185-.01-.397-.01-.61-.01-.211 0-.555.08-.846.397-.291.318-1.11 1.086-1.11 2.65s1.14 3.072 1.298 3.284c.159.212 2.24 3.42 5.423 4.793.758.327 1.35.521 1.812.667.76.241 1.454.207 2.002.125.61-.091 1.88-.768 2.144-1.483.264-.714.264-1.324.185-1.454-.078-.129-.29-.211-.607-.37z"/>
        </svg>
    `;
    document.body.appendChild(waButton);
});
