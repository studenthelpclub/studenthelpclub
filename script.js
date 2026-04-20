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
    return `#SHC-${datePart}-${timePart}`;
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
    
    // Price extract from text "₹29" -> 29
    const priceText = card.querySelector('.price-tag').innerText;
    const priceValue = parseInt(priceText.replace(/[^0-9]/g, '')) || 29;
    
    addToCart({
        name: `${code} (${medium}) [${session}]`,
        price: priceValue
    });
}

function addToCart(item) {
    const exists = cart.some(c => c.name === item.name);
    if (!exists) {
        cart.push(item);
        localStorage.setItem('shc-cart', JSON.stringify(cart));
        updateUI();
        showToast("✅ Added: " + item.name);
    } else {
        showToast("⚠️ Already in selection!");
    }
}

// --- WHATSAPP MESSAGING ---
function checkoutWA() {
    if (cart.length === 0) return;
    const orderId = generateOrderId();
    const today = new Date().toLocaleDateString('en-GB');
    let total = cart.reduce((sum, item) => sum + item.price, 0);

    let msg = `*📦 NEW ORDER - STUDENT HELP CLUB*\n`;
    msg += `-----------------------------------\n`;
    msg += `*Date:* ${today}\n`;
    msg += `*Order ID:* ${orderId}\n\n`;
    msg += `*Items List:*\n`;
    msg += cart.map(i => `✅ ${i.name} - _₹${i.price}_`).join("\n");
    msg += `\n\n*Total Amount:* ₹${total}\n`;
    msg += `-----------------------------------\n`;
    msg += `*Message:* Hi, I want to buy these solved assignments. Please send me the QR code for payment.`;

    window.open(`https://wa.me/916202368003?text=${encodeURIComponent(msg)}`, '_blank');
}

function directBuy(subjectId) {
    const card = document.getElementById('card-' + subjectId);
    if (!card) return;
    const orderId = generateOrderId();
    const code = card.querySelector('h3').innerText;
    const medium = card.querySelector('.opt-medium').value;
    const session = card.querySelector('.opt-session').value;
    
    // Price extract from text
    const priceText = card.querySelector('.price-tag').innerText;
    const priceValue = priceText.replace(/[^0-9]/g, '') || "29";
    
    let msg = `*📦 QUICK PURCHASE - STUDENT HELP CLUB*\n`;
    msg += `-----------------------------------\n`;
    msg += `*Order ID:* ${orderId}\n\n`;
    msg += `*Item:* ✅ ${code} (${medium})\n`;
    msg += `*Session:* ${session}\n`;
    msg += `*Price:* ₹${priceValue}\n`;
    msg += `-----------------------------------\n`;
    msg += `*Message:* Hi, I want to buy this single assignment. Please guide me for payment.`;

    window.open(`https://wa.me/916202368003?text=${encodeURIComponent(msg)}`, '_blank');
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
            <span style="font-size: 0.85rem;">📚 ${item.name} (₹${item.price})</span>
            <i class="fas fa-trash-alt" style="color:#ef4444; cursor:pointer" onclick="removeFromCart(${index})"></i>
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
                <strong>${item.code}</strong> - ${item.name} <small>(${item.course})</small>
            </a>
        `}).join('');
        resultsDiv.style.display = "block";
    } else {
        resultsDiv.innerHTML = '<div class="search-item">Not found in database</div>';
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
        privacy: { title: "Privacy Policy", content: "Hum aapka koi bhi personal data store nahi karte. Saare orders direct WhatsApp par process hote hain." },
        contact: { title: "Contact Us", content: "WhatsApp: +91 6202368003\nTelegram: @studenthelpclub\nEmail: studenthelpdeskofficial@gmail.com" }
    };
    document.getElementById('legalTitle').innerText = pages[type].title;
    document.getElementById('legalContent').innerText = pages[type].content;
    document.getElementById('legalModal').style.display = 'block';
}
function closeLegal() { document.getElementById('legalModal').style.display = 'none'; }
window.onclick = (e) => { if (e.target.className === 'shc-modal') { closeCart(); closeLegal(); } };