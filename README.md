# HeritageBox Package Check-In System

A mobile-friendly web app for digitizing factory package intake with automatic Stripe invoicing for extra items.

## Features

- 📱 **Mobile-First Design** - Works great on phones and tablets
- 📷 **Barcode Scanning** - Scan UPS tracking numbers with device camera
- 🔗 **Airtable Integration** - Reads/writes order data automatically
- 💳 **Stripe Invoicing** - Auto-generates invoices for extra items ($15/item)
- 🔔 **Payment Tracking** - Webhook updates when invoices are paid

## Workflow

1. Package arrives → Digitizer scans UPS tracking barcode
2. System looks up order in Airtable by tracking number
3. Digitizer enters actual item count
4. If count > expected: Stripe invoice is automatically created and emailed
5. Airtable is updated with received count, extra items, and invoice status

---

## Setup

### 1. Airtable Setup

Your Orders table needs these fields (add any that are missing):

| Field Name | Type | Description |
|------------|------|-------------|
| Order Number | Text | Unique order ID |
| Customer | Text | Customer name |
| Customer Email | Email | For Stripe invoicing |
| Status | Single Select | Pending, Shipped, Received, etc. |
| Label 1 Tracking | Text | UPS tracking number |
| Label 2 Tracking | Text | (optional) |
| Label 3 Tracking | Text | (optional) |
| Package Items Included | Number | Expected item count |
| Items Received | Number | Actual count (filled by app) |
| Extra Items | Number | Calculated overage |
| Extra Items Charge | Currency | $ amount for extras |
| Extra Items Invoice ID | Text | Stripe invoice ID |
| Extra Items Paid | Checkbox | Payment received |
| Extra Items Payment Date | Date | When paid |

**Create an Airtable Personal Access Token:**
1. Go to https://airtable.com/create/tokens
2. Create token with scopes: `data.records:read`, `data.records:write`
3. Add your base to the token's access list

### 2. Stripe Setup

1. Go to https://dashboard.stripe.com/apikeys
2. Copy your **Secret Key** (starts with `sk_live_` or `sk_test_`)
3. Create a webhook endpoint:
   - URL: `https://your-domain.com/api/webhooks/stripe`
   - Events: `invoice.paid`
4. Copy the webhook signing secret (starts with `whsec_`)

### 3. Backend Deployment

#### Option A: Deploy to Railway (Recommended)
```bash
# Install Railway CLI
npm install -g @railway/cli

# Login and deploy
railway login
railway init
railway up
```

#### Option B: Deploy to Render
1. Connect your GitHub repo to Render
2. Create a new Web Service
3. Set environment variables in dashboard

#### Option C: Deploy to Vercel
```bash
npm install -g vercel
vercel
```

#### Environment Variables
Set these in your hosting platform:
```
AIRTABLE_API_KEY=pat_xxxx
AIRTABLE_BASE_ID=appXXXX
STRIPE_SECRET_KEY=sk_live_xxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxx
```

### 4. Frontend Deployment

The `index.html` file can be hosted anywhere:

#### Option A: Netlify Drop
Just drag the file to https://app.netlify.com/drop

#### Option B: Vercel
```bash
vercel --prod
```

#### Option C: GitHub Pages
Push to a repo and enable Pages in settings.

**Important:** Update the API endpoints in `index.html` to point to your deployed backend:

```javascript
// Change this:
const API_BASE = 'http://localhost:3000';

// To your deployed URL:
const API_BASE = 'https://your-api.railway.app';
```

---

## Usage

### For Digitizers

1. Open the app on your phone
2. Tap "Scan Barcode" and point camera at UPS label
3. Review the order details that appear
4. Enter the actual number of items in the package
5. Tap "Confirm Check-In"

If there are extra items:
- An invoice is automatically created and emailed to the customer
- The order is updated in Airtable with the overage details

### Demo Mode

The app includes demo mode for testing without API connections:
- Toggle "Demo Mode" on the main screen
- Use the sample tracking numbers provided
- No actual Airtable or Stripe calls are made

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/orders/tracking/:trackingNumber` | Look up order by UPS tracking |
| POST | `/api/orders/:recordId/checkin` | Submit check-in with item count |
| GET | `/api/invoices/:invoiceId/status` | Check invoice payment status |
| POST | `/api/webhooks/stripe` | Stripe webhook receiver |
| GET | `/api/health` | Health check |

### Example: Check-in Request

```bash
curl -X POST https://your-api.com/api/orders/recXXXXXX/checkin \
  -H "Content-Type: application/json" \
  -d '{"itemsReceived": 15}'
```

Response:
```json
{
  "success": true,
  "order": {
    "id": "recXXXXXX",
    "fields": {
      "Order Number": "HB-123456-789",
      "Items Received": 15,
      "Extra Items": 5,
      "Extra Items Charge": 75
    }
  },
  "invoice": {
    "id": "inv_xxxxx",
    "url": "https://invoice.stripe.com/...",
    "amount": 75
  }
}
```

---

## Customization

### Change Extra Item Price

In `server.js`:
```javascript
const EXTRA_ITEM_PRICE = 15.00; // Change this value
```

In `index.html`:
```javascript
EXTRA_ITEM_PRICE: 15.00, // Change this value
```

### Add Authentication

For production, add authentication middleware:

```javascript
// Simple API key auth
app.use('/api', (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});
```

### Custom Invoice Text

In `server.js`, modify the invoice item description:
```javascript
description: `Your custom text here - Order ${orderNumber}`
```

---

## Troubleshooting

### Camera not working
- Ensure HTTPS (required for camera access)
- Check browser permissions
- Try manual entry as fallback

### Order not found
- Verify tracking number format
- Check Airtable field names match exactly
- Ensure API token has read access

### Invoice not created
- Check Stripe API key is valid
- Verify customer email exists in Airtable
- Check Stripe dashboard for errors

### Webhook not updating
- Verify webhook URL is accessible
- Check webhook secret is correct
- View webhook logs in Stripe dashboard

---

## Support

For issues with this system, check:
1. Browser console for frontend errors
2. Server logs for backend errors
3. Stripe Dashboard → Developers → Logs
4. Airtable automation history
