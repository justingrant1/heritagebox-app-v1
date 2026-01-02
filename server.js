/**
 * HeritageBox Check-In Backend Server
 * 
 * This server handles:
 * 1. Secure Airtable API calls
 * 2. Stripe invoice creation
 * 3. Webhook handling for payment status
 * 
 * Deploy this to: Vercel, Railway, Render, or any Node.js host
 */

const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const Airtable = require('airtable');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ============================================
// CONFIGURATION
// ============================================
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const airtable = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY });
const base = airtable.base(process.env.AIRTABLE_BASE_ID);

const EXTRA_ITEM_PRICE = 15.00; // $15 per extra item
const ORDERS_TABLE = 'Orders';

// ============================================
// ROUTES
// ============================================

/**
 * Look up order by tracking number
 * GET /api/orders/tracking/:trackingNumber
 */
app.get('/api/orders/tracking/:trackingNumber', async (req, res) => {
    try {
        const { trackingNumber } = req.params;
        
        const records = await base(ORDERS_TABLE).select({
            filterByFormula: `OR(
                {Label 1 Tracking}='${trackingNumber}',
                {Label 2 Tracking}='${trackingNumber}',
                {Label 3 Tracking}='${trackingNumber}'
            )`,
            maxRecords: 1
        }).firstPage();
        
        if (records.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        const record = records[0];
        res.json({
            id: record.id,
            fields: record.fields
        });
    } catch (error) {
        console.error('Error looking up order:', error);
        res.status(500).json({ error: 'Failed to lookup order' });
    }
});

/**
 * Check in a package and create invoice if needed
 * POST /api/orders/:recordId/checkin
 * Body: { itemsReceived: number }
 */
app.post('/api/orders/:recordId/checkin', async (req, res) => {
    try {
        const { recordId } = req.params;
        const { itemsReceived } = req.body;
        
        // Get current order
        const order = await base(ORDERS_TABLE).find(recordId);
        const expectedItems = order.fields['Package Items Included'] || 0;
        const extraItems = Math.max(0, itemsReceived - expectedItems);
        const extraCharge = extraItems * EXTRA_ITEM_PRICE;
        
        let invoiceId = null;
        let invoiceUrl = null;
        
        // Create Stripe invoice if there are extra items
        if (extraItems > 0) {
            const customerEmail = order.fields['Customer Email'];
            const orderNumber = order.fields['Order Number'];
            
            // Find or create Stripe customer
            let customer;
            const existingCustomers = await stripe.customers.list({
                email: customerEmail,
                limit: 1
            });
            
            if (existingCustomers.data.length > 0) {
                customer = existingCustomers.data[0];
            } else {
                customer = await stripe.customers.create({
                    email: customerEmail,
                    name: order.fields['Customer'],
                    metadata: {
                        airtable_order: orderNumber
                    }
                });
            }
            
            // Create invoice
            const invoice = await stripe.invoices.create({
                customer: customer.id,
                collection_method: 'send_invoice',
                days_until_due: 7,
                metadata: {
                    order_number: orderNumber,
                    extra_items: extraItems.toString()
                }
            });
            
            // Add line item
            await stripe.invoiceItems.create({
                customer: customer.id,
                invoice: invoice.id,
                amount: Math.round(extraCharge * 100), // Stripe uses cents
                currency: 'usd',
                description: `Additional digitization items (${extraItems} items @ $${EXTRA_ITEM_PRICE}/each) - Order ${orderNumber}`
            });
            
            // Finalize and send
            const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id);
            await stripe.invoices.sendInvoice(finalizedInvoice.id);
            
            invoiceId = finalizedInvoice.id;
            invoiceUrl = finalizedInvoice.hosted_invoice_url;
        }
        
        // Update Airtable
        const updatedRecord = await base(ORDERS_TABLE).update(recordId, {
            'Items Received': itemsReceived,
            'Extra Items': extraItems,
            'Extra Items Charge': extraCharge,
            'Status': 'Received',
            ...(invoiceId && { 'Extra Items Invoice ID': invoiceId })
        });
        
        res.json({
            success: true,
            order: {
                id: updatedRecord.id,
                fields: updatedRecord.fields
            },
            invoice: invoiceId ? {
                id: invoiceId,
                url: invoiceUrl,
                amount: extraCharge
            } : null
        });
        
    } catch (error) {
        console.error('Error checking in order:', error);
        res.status(500).json({ error: 'Failed to check in order', details: error.message });
    }
});

/**
 * Stripe webhook handler for payment events
 * POST /api/webhooks/stripe
 */
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    
    try {
        event = stripe.webhooks.constructEvent(
            req.body,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
        );
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    // Handle invoice payment
    if (event.type === 'invoice.paid') {
        const invoice = event.data.object;
        const orderNumber = invoice.metadata?.order_number;
        
        if (orderNumber) {
            try {
                // Find and update order in Airtable
                const records = await base(ORDERS_TABLE).select({
                    filterByFormula: `{Order Number}='${orderNumber}'`,
                    maxRecords: 1
                }).firstPage();
                
                if (records.length > 0) {
                    await base(ORDERS_TABLE).update(records[0].id, {
                        'Extra Items Paid': true,
                        'Extra Items Payment Date': new Date().toISOString().split('T')[0]
                    });
                    console.log(`Updated payment status for order ${orderNumber}`);
                }
            } catch (error) {
                console.error('Error updating payment status:', error);
            }
        }
    }
    
    res.json({ received: true });
});

/**
 * Get invoice payment status
 * GET /api/invoices/:invoiceId/status
 */
app.get('/api/invoices/:invoiceId/status', async (req, res) => {
    try {
        const { invoiceId } = req.params;
        const invoice = await stripe.invoices.retrieve(invoiceId);
        
        res.json({
            id: invoice.id,
            status: invoice.status,
            paid: invoice.paid,
            amount_due: invoice.amount_due / 100,
            amount_paid: invoice.amount_paid / 100,
            hosted_invoice_url: invoice.hosted_invoice_url,
            created: new Date(invoice.created * 1000).toISOString()
        });
    } catch (error) {
        console.error('Error fetching invoice:', error);
        res.status(500).json({ error: 'Failed to fetch invoice status' });
    }
});

/**
 * Health check
 * GET /api/health
 */
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`HeritageBox Check-In API running on port ${PORT}`);
});

module.exports = app;
