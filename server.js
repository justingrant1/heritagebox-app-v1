/**
 * HeritageBox Employee App Backend Server
 * 
 * This server handles:
 * 1. Package check-in with Airtable
 * 2. Stripe invoice creation for extra items
 * 3. Employee work queue management
 * 4. Pay tracking and calculations
 * 
 * Deploy to: Render, Railway, Vercel, or any Node.js host
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

const EXTRA_ITEM_PRICE = 15.00;
const BASE_PAY = 7.50;
const PER_ITEM_PAY = 2.00;
const ORDERS_TABLE = 'Orders';
const EMPLOYEES_TABLE = 'Employees';
const PAY_PERIODS_TABLE = 'Pay_Periods';

// ============================================
// EMPLOYEE ROUTES
// ============================================

/**
 * Get active employees
 * GET /api/employees
 */
app.get('/api/employees', async (req, res) => {
    try {
        const records = await base(EMPLOYEES_TABLE).select({
            fields: ['Employee Name', 'Active'],
            sort: [{ field: 'Employee Name', direction: 'asc' }]
        }).firstPage();
        
        const employees = records
            .filter(r => r.fields['Active'] === true || r.fields['Active'] === undefined)
            .map(r => ({
                id: r.id,
                name: r.fields['Employee Name']
            }));
        
        res.json({ employees });
    } catch (error) {
        console.error('Error fetching employees:', error.message);
        res.status(500).json({ error: 'Failed to fetch employees' });
    }
});

/**
 * Get employee's work queue (orders to digitize)
 * GET /api/employees/:employeeId/work
 */
app.get('/api/employees/:employeeId/work', async (req, res) => {
    try {
        const { employeeId } = req.params;
        const employeeName = req.query.name; // Pass employee name as query param
        
        console.log(`Fetching work queue for employee: ${employeeId}, name: ${employeeName}`);
        
        // Get all non-complete orders and filter in code for more reliable matching
        const records = await base(ORDERS_TABLE).select({
            filterByFormula: `{Ops Status}!='Complete'`,
            fields: ['Order Number', 'Customer', 'Customer Name', 'Customer Email', 'Items Received', 'Ops Status', 'Package Items Included', 'Assigned Employee', 'Check-In Notes'],
            sort: [{ field: 'Created Time', direction: 'asc' }]
        }).firstPage();
        
        console.log(`Found ${records.length} non-complete orders`);
        
        // Filter for orders assigned to this employee (by name or ID)
        const filteredRecords = records.filter(r => {
            const assignedEmployee = r.fields['Assigned Employee'];
            if (!assignedEmployee) return false;
            
            // Handle single select (string name like "Justin")
            if (typeof assignedEmployee === 'string') {
                // Match by name if provided, or check if name contains employee ID
                if (employeeName) {
                    return assignedEmployee.toLowerCase() === employeeName.toLowerCase();
                }
                return false;
            }
            
            // Handle array of linked record IDs
            if (Array.isArray(assignedEmployee)) {
                return assignedEmployee.includes(employeeId);
            }
            
            return assignedEmployee === employeeId;
        });
        
        console.log(`Found ${filteredRecords.length} orders assigned to employee`);
        
        // Process orders and fetch USB drive counts
        const orders = await Promise.all(filteredRecords.map(async (r) => {
            let customerName = r.fields['Customer Name'] || r.fields['Customer'];
            if (Array.isArray(customerName)) customerName = customerName[0];
            
            let customerEmail = r.fields['Customer Email'];
            if (Array.isArray(customerEmail)) customerEmail = customerEmail[0];
            
            // Check for USB drives in order items
            let usbDriveCount = 0;
            if (r.fields['Order Items'] && Array.isArray(r.fields['Order Items'])) {
                try {
                    const orderItemRecords = await base('Order Items').select({
                        filterByFormula: `OR(${r.fields['Order Items'].map(id => `RECORD_ID()='${id}'`).join(',')})`,
                        fields: ['Product Name', 'Quantity']
                    }).firstPage();
                    
                    orderItemRecords.forEach(item => {
                        const productName = Array.isArray(item.fields['Product Name']) 
                            ? item.fields['Product Name'][0] 
                            : item.fields['Product Name'];
                        if (productName && productName.toLowerCase().includes('usb')) {
                            usbDriveCount += item.fields['Quantity'] || 0;
                        }
                    });
                } catch (err) {
                    console.error('Error fetching order items:', err.message);
                }
            }
            
            return {
                id: r.id,
                fields: {
                    'Order Number': r.fields['Order Number'],
                    'Customer': customerName,
                    'Customer Email': customerEmail || '',
                    'Items Received': r.fields['Items Received'],
                    'Ops Status': r.fields['Ops Status'],
                    'Package Items Included': r.fields['Package Items Included'],
                    'Check-In Notes': r.fields['Check-In Notes'] || '',
                    'USB Drive Count': usbDriveCount
                }
            };
        }));
        
        res.json({ orders });
    } catch (error) {
        console.error('Error fetching work queue:', error.message);
        res.status(500).json({ error: 'Failed to fetch work queue' });
    }
});

/**
 * Get employee's pay information
 * GET /api/employees/:employeeId/pay
 */
app.get('/api/employees/:employeeId/pay', async (req, res) => {
    try {
        const { employeeId } = req.params;
        const employeeName = req.query.name;
        
        console.log(`Fetching pay info for employee: ${employeeId}, name: ${employeeName}`);
        
        // Get all completed orders and filter in code
        const allCompleted = await base(ORDERS_TABLE).select({
            filterByFormula: `{Digitization Complete}=TRUE()`,
            fields: ['Order Number', 'Items Digitized', 'Base Pay', 'Per Item Pay', 'Total Order Pay', 'Digitization Completion Date', 'Employee Link'],
            sort: [{ field: 'Digitization Completion Date', direction: 'desc' }]
        }).firstPage();
        
        console.log(`Found ${allCompleted.length} total completed orders`);
        
        // Filter for this employee's orders
        const completedOrders = allCompleted.filter(r => {
            const empLink = r.fields['Employee Link'];
            if (!empLink) return false;
            
            // Handle linked record (array of IDs)
            if (Array.isArray(empLink)) {
                return empLink.includes(employeeId);
            }
            return empLink === employeeId;
        });
        
        console.log(`Found ${completedOrders.length} orders for employee ${employeeId}`);
        
        // Calculate stats
        let totalEarnings = 0;
        let totalOrders = 0;
        let totalItems = 0;
        
        const recentOrders = completedOrders.slice(0, 5).map(r => {
            const itemsDigitized = r.fields['Items Digitized'] || 0;
            const pay = (r.fields['Total Order Pay'] || 0);
            totalEarnings += pay;
            totalOrders++;
            totalItems += itemsDigitized;
            
            return {
                id: r.id,
                orderNumber: r.fields['Order Number'],
                itemsDigitized,
                pay,
                date: r.fields['Digitization Completion Date']
            };
        });
        
        // Calculate totals from all orders
        completedOrders.slice(5).forEach(r => {
            totalEarnings += (r.fields['Total Order Pay'] || 0);
            totalOrders++;
            totalItems += (r.fields['Items Digitized'] || 0);
        });
        
        console.log(`Total earnings: $${totalEarnings}, orders: ${totalOrders}, items: ${totalItems}`);
        
        // Get current pay period
        let currentPeriod = { name: 'Current Period', totalEarnings: 0 };
        try {
            const periods = await base(PAY_PERIODS_TABLE).select({
                filterByFormula: `{Status}!='Paid'`,
                sort: [{ field: 'Start Date', direction: 'desc' }],
                maxRecords: 1
            }).firstPage();
            
            if (periods.length > 0) {
                currentPeriod.name = periods[0].fields['Pay Period Name'] || 'Current Period';
            }
        } catch (e) {
            console.log('Could not fetch pay periods:', e.message);
        }
        
        // Calculate current period earnings (simplified - all unpaid orders)
        currentPeriod.totalEarnings = totalEarnings;
        
        res.json({
            currentPeriod,
            stats: {
                ordersCompleted: totalOrders,
                itemsDigitized: totalItems,
                totalEarnings
            },
            recentOrders
        });
    } catch (error) {
        console.error('Error fetching pay info:', error.message);
        res.status(500).json({ error: 'Failed to fetch pay info' });
    }
});

// ============================================
// ORDER ROUTES
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
        if (trackingNumber.length <= 5) {
            formula = `OR(
                RIGHT({Label 1 Tracking}, ${trackingNumber.length})='${trackingNumber}',
                RIGHT({Label 2 Tracking}, ${trackingNumber.length})='${trackingNumber}',
                RIGHT({Label 3 Tracking}, ${trackingNumber.length})='${trackingNumber}'
            )`;
        } else {
            formula = `OR({Label 1 Tracking}='${trackingNumber}',{Label 2 Tracking}='${trackingNumber}',{Label 3 Tracking}='${trackingNumber}')`;
        }
        
        const records = await base(ORDERS_TABLE).select({
            filterByFormula: formula,
            maxRecords: 10
        }).firstPage();
        
        if (records.length === 0) {
            return res.status(404).json({ error: 'Order not found', trackingNumber });
        }
        
        if (records.length > 1) {
            const matches = records.map(r => ({
                orderNumber: r.fields['Order Number'],
                customer: r.fields['Customer Name'] || r.fields['Customer']
            }));
            return res.status(400).json({ error: 'Multiple orders match. Use more digits.', matches });
        }
        
        const record = records[0];
        
        // Handle linked Customer field
        let customerName = record.fields['Customer'];
        if (Array.isArray(customerName) && customerName.length > 0) {
            if (record.fields['Customer Name']) {
                customerName = Array.isArray(record.fields['Customer Name']) 
                    ? record.fields['Customer Name'][0] 
                    : record.fields['Customer Name'];
            }
        }
        
        // Check for USB drives in order items
        let usbDriveCount = 0;
        if (record.fields['Order Items'] && Array.isArray(record.fields['Order Items'])) {
            try {
                const orderItemRecords = await base('Order Items').select({
                    filterByFormula: `OR(${record.fields['Order Items'].map(id => `RECORD_ID()='${id}'`).join(',')})`,
                    fields: ['Product Name', 'Quantity']
                }).firstPage();
                
                orderItemRecords.forEach(item => {
                    const productName = Array.isArray(item.fields['Product Name']) 
                        ? item.fields['Product Name'][0] 
                        : item.fields['Product Name'];
                    if (productName && productName.toLowerCase().includes('usb')) {
                        usbDriveCount += item.fields['Quantity'] || 0;
                    }
                });
            } catch (err) {
                console.error('Error fetching order items:', err.message);
            }
        }
        
        res.json({
            id: record.id,
            fields: {
                ...record.fields,
                'Customer': customerName,
                'USB Drive Count': usbDriveCount
            }
        });
    } catch (error) {
        console.error('Error looking up order:', error.message);
        res.status(500).json({ error: 'Failed to lookup order', details: error.message });
    }
});

/**
 * Check in a package
 * POST /api/orders/:recordId/checkin
 */
app.post('/api/orders/:recordId/checkin', async (req, res) => {
    try {
        const { recordId } = req.params;
        const { itemsReceived, employeeId, employeeName, notes } = req.body;
        
        console.log(`Checking in order ${recordId} with ${itemsReceived} items by employee ${employeeName || employeeId}`);
        
        const order = await base(ORDERS_TABLE).find(recordId);
        const expectedItems = order.fields['Package Items Included'] || 0;
        const extraItems = Math.max(0, itemsReceived - expectedItems);
        const extraCharge = extraItems * EXTRA_ITEM_PRICE;
        
        let invoiceId = null;
        let invoiceUrl = null;
        
        // Create Stripe invoice if there are extra items
        if (extraItems > 0) {
            let customerEmail = order.fields['Customer Email'];
            if (Array.isArray(customerEmail)) customerEmail = customerEmail[0];
            
            let customerName = order.fields['Customer Name'] || order.fields['Customer'];
            if (Array.isArray(customerName)) customerName = customerName[0];
            
            const orderNumber = order.fields['Order Number'];
            
            if (customerEmail) {
                try {
                    let customer;
                    const existingCustomers = await stripe.customers.list({ email: customerEmail, limit: 1 });
                    
                    if (existingCustomers.data.length > 0) {
                        customer = existingCustomers.data[0];
                    } else {
                        customer = await stripe.customers.create({
                            email: customerEmail,
                            name: customerName || 'Customer',
                            metadata: { airtable_order: orderNumber }
                        });
                    }
                    
                    const invoice = await stripe.invoices.create({
                        customer: customer.id,
                        collection_method: 'send_invoice',
                        days_until_due: 7,
                        metadata: { order_number: orderNumber, extra_items: extraItems.toString() }
                    });
                    
                    await stripe.invoiceItems.create({
                        customer: customer.id,
                        invoice: invoice.id,
                        amount: Math.round(extraCharge * 100),
                        currency: 'usd',
                        description: `Additional digitization items (${extraItems} items @ $${EXTRA_ITEM_PRICE}/each) - Order ${orderNumber}`
                    });
                    
                    const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id);
                    await stripe.invoices.sendInvoice(finalizedInvoice.id);
                    
                    invoiceId = finalizedInvoice.id;
                    invoiceUrl = finalizedInvoice.hosted_invoice_url;
                } catch (stripeError) {
                    console.error('Stripe error:', stripeError.message);
                }
            }
        }
        
        // Update Airtable
        const updateFields = {
            'Items Received': itemsReceived,
            'Extra Items': extraItems,
            'Extra Items Charge': extraCharge,
            'Ops Status': 'Digitizing',
            ...(invoiceId && { 'Extra Items Invoice ID': invoiceId }),
            ...(employeeId && { 'Assigned Employee': [employeeId] }),
            ...(notes && { 'Check-In Notes': notes })
        };
        
        const updatedRecord = await base(ORDERS_TABLE).update(recordId, updateFields);
        
        res.json({
            success: true,
            order: { id: updatedRecord.id, fields: updatedRecord.fields },
            invoice: invoiceId ? { id: invoiceId, url: invoiceUrl, amount: extraCharge } : null
        });
        
    } catch (error) {
        console.error('Error checking in order:', error.message);
        res.status(500).json({ error: 'Failed to check in order', details: error.message });
    }
});

/**
 * Update order notes
 * PATCH /api/orders/:recordId/notes
 */
app.patch('/api/orders/:recordId/notes', async (req, res) => {
    try {
        const { recordId } = req.params;
        const { notes } = req.body;
        
        console.log(`Updating notes for order ${recordId}`);
        
        const updatedRecord = await base(ORDERS_TABLE).update(recordId, {
            'Check-In Notes': notes || ''
        });
        
        res.json({
            success: true,
            notes: updatedRecord.fields['Check-In Notes']
        });
        
    } catch (error) {
        console.error('Error updating notes:', error.message);
        res.status(500).json({ error: 'Failed to update notes', details: error.message });
    }
});

/**
 * Complete digitization of an order
 * POST /api/orders/:recordId/complete
 */
app.post('/api/orders/:recordId/complete', async (req, res) => {
    try {
        const { recordId } = req.params;
        const { itemsDigitized, employeeId, employeeName } = req.body;
        
        console.log(`Completing order ${recordId} with ${itemsDigitized} items digitized by ${employeeName || employeeId}`);
        
        // Calculate pay for response (Airtable will calculate via formulas)
        const basePay = BASE_PAY;
        const perItemPay = itemsDigitized * PER_ITEM_PAY;
        const totalPay = basePay + perItemPay;
        
        // Update order - don't include computed fields (Base Pay, Per Item Pay, Total Order Pay)
        // Those are formulas in Airtable that auto-calculate
        const updateFields = {
            'Items Digitized': itemsDigitized,
            'Digitization Complete': true,
            'Digitization Completion Date': new Date().toISOString().split('T')[0],
            'Ops Status': 'Quality Control'
        };
        
        // Add Employee Link if we have employee info (it's a linked record field)
        if (employeeId) {
            updateFields['Employee Link'] = [employeeId];
        }
        
        console.log('Update fields:', JSON.stringify(updateFields));
        
        const updatedRecord = await base(ORDERS_TABLE).update(recordId, updateFields);
        
        console.log(`Order ${recordId} completed. Pay: $${totalPay}`);
        
        res.json({
            success: true,
            order: { id: updatedRecord.id, fields: updatedRecord.fields },
            pay: { basePay, perItemPay, totalPay }
        });
        
    } catch (error) {
        console.error('Error completing order:', error.message);
        console.error('Full error:', error);
        res.status(500).json({ error: 'Failed to complete order', details: error.message });
    }
});

// ============================================
// STRIPE WEBHOOK
// ============================================

app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    if (event.type === 'invoice.paid') {
        const invoice = event.data.object;
        const orderNumber = invoice.metadata?.order_number;
        
        if (orderNumber) {
            try {
                const records = await base(ORDERS_TABLE).select({
                    filterByFormula: `{Order Number}='${orderNumber}'`,
                    maxRecords: 1
                }).firstPage();
                
                if (records.length > 0) {
                    await base(ORDERS_TABLE).update(records[0].id, {
                        'Extra Items Paid': true,
                        'Extra Items Payment Date': new Date().toISOString().split('T')[0]
                    });
                }
            } catch (error) {
                console.error('Error updating payment status:', error);
            }
        }
    }
    
    res.json({ received: true });
});

// ============================================
// UTILITY ROUTES
// ============================================

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`HeritageBox API running on port ${PORT}`);
});

module.exports = app;
