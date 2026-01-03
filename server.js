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
 * Look up order by tracking number (full or last 5 digits)
 * GET /api/orders/tracking/:trackingNumber
 */
app.get('/api/orders/tracking/:trackingNumber', async (req, res) => {
    try {
        const { trackingNumber } = req.params;
        
        console.log(`Looking up tracking number: ${trackingNumber}`);
        
        let formula;
        
        // If 5 or fewer characters, search by last digits using RIGHT() function
        if (trackingNumber.length <= 5) {
            formula = `OR(
                RIGHT({Label 1 Tracking}, ${trackingNumber.length})='${trackingNumber}',
                RIGHT({Label 2 Tracking}, ${trackingNumber.length})='${trackingNumber}',
                RIGHT({Label 3 Tracking}, ${trackingNumber.length})='${trackingNumber}'
            )`;
        } else {
            // Full tracking number - exact match
            formula = `OR({Label 1 Tracking}='${trackingNumber}',{Label 2 Tracking}='${trackingNumber}',{Label 3 Tracking}='${trackingNumber}')`;
        }
        
        console.log(`Using formula: ${formula}`);
        
        const records = await base(ORDERS_TABLE).select({
            filterByFormula: formula,
            maxRecords: 10 // Get more in case of duplicates
        }).firstPage();
        
        console.log(`Found ${records.length} records`);
        
        if (records.length === 0) {
            return res.status(404).json({ error: 'Order not found', trackingNumber });
        }
        
        // If multiple matches, return error with options
        if (records.length > 1) {
            const matches = records.map(r => ({
                orderNumber: r.fields['Order Number'],
                customer: r.fields['Customer Name'] || r.fields['Customer'],
                tracking1: r.fields['Label 1 Tracking'],
                tracking2: r.fields['Label 2 Tracking'],
                tracking3: r.fields['Label 3 Tracking']
            }));
            return res.status(400).json({ 
                error: 'Multiple orders match. Use more digits.', 
                matches 
            });
        }
        
        const record = records[0];
        console.log(`Found order: ${record.fields['Order Number']}`);
        
        // Handle linked Customer field - fetch the actual customer name
        let customerName = record.fields['Customer'];
        
        // If Customer is a linked record (array of IDs), fetch the name
        if (Array.isArray(customerName) && customerName.length > 0) {
            try {
                // Try to use Customer Name lookup field first
                if (record.fields['Customer Name']) {
                    customerName = Array.isArray(record.fields['Customer Name']) 
                        ? record.fields['Customer Name'][0] 
                        : record.fields['Customer Name'];
                } else {
                    // Fallback: fetch from Customers table
                    const customerRecord = await base('Customers').find(customerName[0]);
                    customerName = customerRecord.fields['Name'] || customerRecord.fields['Customer Name'] || 'Unknown';
                }
            } catch (e) {
                console.log('Could not fetch customer name:', e.message);
                customerName = 'Customer';
            }
        }
        
        // Build response with cleaned up customer name
        const responseFields = {
            ...record.fields,
            'Customer': customerName
        };
        
        res.json({
            id: record.id,
            fields: responseFields
        });
    } catch (error) {
        console.error('Error looking up order:', error.message);
        console.error('Full error:', error);
        res.status(500).json({ error: 'Failed to lookup order', details: error.message });
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
        
        console.log(`Checking in order ${recordId} with ${itemsReceived} items`);
        
        // Get current order
        const order = await base(ORDERS_TABLE).find(recordId);
        const expectedItems = order.fields['Package Items Included'] || 0;
        const extraItems = Math.max(0, itemsReceived - expectedItems);
        const extraCharge = extraItems * EXTRA_ITEM_PRICE;
        
        console.log(`Expected: ${expectedItems}, Received: ${itemsReceived}, Extra: ${extraItems}`);
        
        let invoiceId = null;
        let invoiceUrl = null;
        
        // Create Stripe invoice if there are extra items
        if (extraItems > 0) {
            // Handle Customer Email - might be array from lookup field
            let customerEmail = order.fields['Customer Email'];
            if (Array.isArray(customerEmail)) {
                customerEmail = customerEmail[0];
            }
            
            // Handle Customer Name - might be array from linked field
            let customerName = order.fields['Customer Name'] || order.fields['Customer'];
            if (Array.isArray(customerName)) {
                customerName = customerName[0];
            }
            
            const orderNumber = order.fields['Order Number'];
            
            console.log(`Creating invoice for ${customerEmail}, order ${orderNumber}`);
            
            if (!customerEmail) {
                console.error('No customer email found for order');
                // Continue without invoice - don't fail the whole check-in
            } else {
                try {
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
                            name: customerName || 'Customer',
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
                    
                    console.log(`Invoice created: ${invoiceId}`);
                } catch (stripeError) {
                    console.error('Stripe error:', stripeError.message);
                    // Continue without invoice - don't fail the whole check-in
                }
            }
        }
        
        // Update Airtable
        const updatedRecord = await base(ORDERS_TABLE).update(recordId, {
            'Items Received': itemsReceived,
            'Extra Items': extraItems,
            'Extra Items Charge': extraCharge,
            'Status': 'Received',
            ...(invoiceId && { 'Extra Items Invoice ID': invoiceId })
        });
        
        console.log(`Order ${recordId} updated successfully`);
        
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
        console.error('Error checking in order:', error.message);
        console.error('Full error:', error);
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
