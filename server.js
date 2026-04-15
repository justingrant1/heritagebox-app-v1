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
const PER_ITEM_PAY = 2.00;

// Fallback base pay by package type (used if Airtable Base Pay field is empty)
const BASE_PAY_BY_PACKAGE_TYPE = {
    'Starter': 15.00,
    'Popular': 22.50,
    'Dusty Rose': 30.00,
    'Eternal': 37.50
};

const getBasePayFallback = (packageType) => BASE_PAY_BY_PACKAGE_TYPE[packageType] || 0;

const ORDERS_TABLE = 'Orders';
const EMPLOYEES_TABLE = 'Employees';
const PAY_PERIODS_TABLE = 'Pay Periods';

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
        
        // Get only orders in 'Digitizing' status (not Quality Check, Complete, or other post-digitizing stages)
        const records = await base(ORDERS_TABLE).select({
            filterByFormula: `{Ops Status}='Digitizing'`,
            fields: ['Order Number', 'Customer', 'Customer Name', 'Customer Email', 'Items Received', 'Ops Status', 'Package Items Included', 'Assigned Employee', 'Check-In Notes', 'Order Items', 'Base Pay', 'Per Item Pay', 'Package Type'],
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
        
        // Process orders and fetch USB drive counts + expedited/rush status
        const orders = await Promise.all(filteredRecords.map(async (r) => {
            let customerName = r.fields['Customer Name'] || r.fields['Customer'];
            if (Array.isArray(customerName)) customerName = customerName[0];
            
            let customerEmail = r.fields['Customer Email'];
            if (Array.isArray(customerEmail)) customerEmail = customerEmail[0];
            
            // Check for USB drives and expedited/rush processing in order items
            let usbDriveCount = 0;
            let expeditedType = null; // null | 'Expedited Processing' | 'Rush Processing'
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
                        if (!productName) return;
                        const nameLower = productName.toLowerCase();
                        if (nameLower.includes('usb')) {
                            usbDriveCount += item.fields['Quantity'] || 0;
                        }
                        if (nameLower.includes('expedited')) {
                            expeditedType = 'Expedited Processing';
                        } else if (nameLower.includes('rush')) {
                            expeditedType = 'Rush Processing';
                        }
                    });
                } catch (err) {
                    console.error('Error fetching order items:', err.message);
                }
            }
            
            const packageType = r.fields['Package Type'] || '';
            const basePay = r.fields['Base Pay'] != null ? r.fields['Base Pay'] : getBasePayFallback(packageType);
            const perItemPay = r.fields['Per Item Pay'] || PER_ITEM_PAY;

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
                    'USB Drive Count': usbDriveCount,
                    'Expedited Type': expeditedType,
                    'Package Type': packageType,
                    'Base Pay': basePay,
                    'Per Item Pay': perItemPay
                }
            };
        }));

        // Fetch completed orders for this employee (current pay period)
        // Determine the date range from the employee's current pay period
        let periodStartDate = null;
        let periodEndDate = null;
        try {
            const allPeriods = await base(PAY_PERIODS_TABLE).select({
                sort: [{ field: 'Start Date', direction: 'desc' }]
            }).firstPage();

            const employeePeriods = allPeriods.filter(p => {
                const employees = p.fields['Employee'];
                if (!employees) return false;
                if (Array.isArray(employees)) return employees.includes(employeeId);
                return employees === employeeId;
            });

            if (employeePeriods.length > 0) {
                // Find current (non-Paid) period first, then fall back to most recent
                const currentPeriod = employeePeriods.find(p => p.fields['Status'] !== 'Paid') || employeePeriods[0];
                periodStartDate = currentPeriod.fields['Start Date'] || null;
                periodEndDate = currentPeriod.fields['End Date'] || null;

                // If no current period found but there are past periods, use the most recent end date as start
                if (!currentPeriod && employeePeriods.length > 0) {
                    periodStartDate = employeePeriods[0].fields['End Date'] || null;
                    periodEndDate = null;
                }
            }
        } catch (err) {
            console.error('Error fetching pay periods for completed orders:', err.message);
        }

        // Build the completed orders filter formula
        let completedFilter;
        if (periodStartDate && periodEndDate) {
            completedFilter = `AND({Digitization Complete}=TRUE(), {Digitization Completion Date}>='${periodStartDate}', {Digitization Completion Date}<='${periodEndDate}')`;
        } else if (periodStartDate) {
            completedFilter = `AND({Digitization Complete}=TRUE(), {Digitization Completion Date}>='${periodStartDate}')`;
        } else {
            // No pay period info at all — show all completed orders
            completedFilter = `{Digitization Complete}=TRUE()`;
        }

        let completedOrders = [];
        try {
            const completedRecords = await base(ORDERS_TABLE).select({
                filterByFormula: completedFilter,
                fields: ['Order Number', 'Customer', 'Customer Name', 'Items Digitized', 'Ops Status', 'Digitization Completion Date', 'Employee Link', 'Assigned Employee'],
                sort: [{ field: 'Digitization Completion Date', direction: 'desc' }]
            }).firstPage();

            const filteredCompleted = completedRecords.filter(r => {
                // Match by Employee Link (linked record) or Assigned Employee (single select name)
                const empLink = r.fields['Employee Link'];
                const assignedEmployee = r.fields['Assigned Employee'];
                
                if (empLink && Array.isArray(empLink) && empLink.includes(employeeId)) return true;
                if (assignedEmployee && employeeName) {
                    if (typeof assignedEmployee === 'string') {
                        return assignedEmployee.toLowerCase() === employeeName.toLowerCase();
                    }
                }
                return false;
            });

            completedOrders = filteredCompleted.map(r => {
                let customerName = r.fields['Customer Name'] || r.fields['Customer'];
                if (Array.isArray(customerName)) customerName = customerName[0];
                return {
                    id: r.id,
                    fields: {
                        'Order Number': r.fields['Order Number'],
                        'Customer': customerName,
                        'Items Digitized': r.fields['Items Digitized'] || 0,
                        'Ops Status': r.fields['Ops Status'],
                        'Digitization Completion Date': r.fields['Digitization Completion Date']
                    }
                };
            });

            console.log(`Found ${completedOrders.length} completed orders for today`);
        } catch (err) {
            console.error('Error fetching completed orders:', err.message);
        }
        
        res.json({ orders, completedOrders });
    } catch (error) {
        console.error('Error fetching work queue:', error.message);
        res.status(500).json({ error: 'Failed to fetch work queue' });
    }
});

/**
 * Get employee's pay information (pay-period-aware)
 * GET /api/employees/:employeeId/pay
 */
app.get('/api/employees/:employeeId/pay', async (req, res) => {
    try {
        const { employeeId } = req.params;
        const employeeName = req.query.name;
        
        console.log(`Fetching pay info for employee: ${employeeId}, name: ${employeeName}`);
        
        // Fetch all pay periods and filter for this employee in code
        const allPeriods = await base(PAY_PERIODS_TABLE).select({
            sort: [{ field: 'Start Date', direction: 'desc' }]
        }).firstPage();
        
        const employeePeriods = allPeriods.filter(p => {
            const employees = p.fields['Employee'];
            if (!employees) return false;
            if (Array.isArray(employees)) return employees.includes(employeeId);
            return employees === employeeId;
        });
        
        console.log(`Found ${employeePeriods.length} pay periods for employee ${employeeId}`);
        
        // For each pay period, fetch orders and calculate totals.
        // - Paid/closed periods: use manually linked order IDs (finalized payroll)
        // - Draft/open periods: dynamically query all completed orders by date range
        //   so employees always see their work in real-time without manual linking.
        const payPeriods = await Promise.all(employeePeriods.map(async (period) => {
            const periodStatus = period.fields['Status'] || 'Draft';
            const linkedOrderIds = period.fields['Orders'] || [];
            const startDate = period.fields['Start Date'] || null;
            const endDate = period.fields['End Date'] || null;

            let periodOrders = [];
            let totalPay = 0;
            let totalItems = 0;
            let totalOrders = 0;

            const isDraft = periodStatus !== 'Paid' && periodStatus !== 'Ready for Payment';

            try {
                let orderRecords = [];

                if (isDraft) {
                    // Dynamic query: find all completed orders for this employee in the date range
                    let formula = `AND({Digitization Complete}=TRUE(), {Employee Link}='${employeeId}'`;
                    if (startDate) formula += `, {Digitization Completion Date}>='${startDate}'`;
                    if (endDate) formula += `, {Digitization Completion Date}<='${endDate}'`;
                    formula += `)`;

                    orderRecords = await base(ORDERS_TABLE).select({
                        filterByFormula: formula,
                        fields: ['Order Number', 'Items Digitized', 'Total Order Pay', 'Digitization Completion Date', 'Base Pay', 'Per Item Pay'],
                        sort: [{ field: 'Digitization Completion Date', direction: 'desc' }]
                    }).firstPage();
                } else if (linkedOrderIds.length > 0) {
                    // Finalized period: use manually linked orders
                    orderRecords = await base(ORDERS_TABLE).select({
                        filterByFormula: `OR(${linkedOrderIds.map(id => `RECORD_ID()='${id}'`).join(',')})`,
                        fields: ['Order Number', 'Items Digitized', 'Total Order Pay', 'Digitization Completion Date', 'Base Pay', 'Per Item Pay']
                    }).firstPage();
                }

                orderRecords.forEach(r => {
                    const pay = r.fields['Total Order Pay'] || 0;
                    const items = r.fields['Items Digitized'] || 0;
                    totalPay += pay;
                    totalItems += items;
                    totalOrders++;
                    periodOrders.push({
                        id: r.id,
                        orderNumber: r.fields['Order Number'],
                        itemsDigitized: items,
                        basePay: r.fields['Base Pay'] || 0,
                        perItemPay: r.fields['Per Item Pay'] || 0,
                        pay,
                        date: r.fields['Digitization Completion Date']
                    });
                });

                // Sort orders by date descending
                periodOrders.sort((a, b) => {
                    if (!a.date) return 1;
                    if (!b.date) return -1;
                    return new Date(b.date) - new Date(a.date);
                });
            } catch (err) {
                console.error('Error fetching orders for pay period:', err.message);
            }
            
            return {
                id: period.id,
                name: period.fields['Pay Period Name'] || 'Unnamed Period',
                startDate: period.fields['Start Date'],
                endDate: period.fields['End Date'],
                status: period.fields['Status'] || 'Draft',
                datePaid: period.fields['Date Paid'],
                totalPay,
                totalItems,
                totalOrders,
                orders: periodOrders
            };
        }));
        
        // Determine current period:
        // payPeriods is already sorted by Start Date desc (newest first)
        // 1. First look for any non-Paid period (Draft, Ready for Payment, etc.) — newest first
        // 2. Fall back to the most recent period (even if Paid)
        
        let currentPeriod = payPeriods.find(p => p.status !== 'Paid');
        
        if (!currentPeriod && payPeriods.length > 0) {
            currentPeriod = payPeriods[0];
        }
        
        console.log(`All periods for employee: ${employeePeriods.map(p => `${p.fields['Pay Period Name']} (${p.fields['Status']})`).join(', ')}`);
        
        console.log(`Current period: ${currentPeriod?.name || 'none'}, total pay: $${currentPeriod?.totalPay || 0}`);
        
        res.json({
            payPeriods,
            currentPeriodId: currentPeriod?.id || null
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
        
        // Check for USB drives and expedited/rush processing in order items
        let usbDriveCount = 0;
        let expeditedType = null; // null | 'Expedited Processing' | 'Rush Processing'
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
                    if (!productName) return;
                    const nameLower = productName.toLowerCase();
                    if (nameLower.includes('usb')) {
                        usbDriveCount += item.fields['Quantity'] || 0;
                    }
                    if (nameLower.includes('expedited')) {
                        expeditedType = 'Expedited Processing';
                    } else if (nameLower.includes('rush')) {
                        expeditedType = 'Rush Processing';
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
                'USB Drive Count': usbDriveCount,
                'Expedited Type': expeditedType
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
        
        // Update order - don't include computed fields (Base Pay, Per Item Pay, Total Order Pay)
        // Those are formulas in Airtable that auto-calculate
        const updateFields = {
            'Items Digitized': itemsDigitized,
            'Digitization Complete': true,
            'Digitization Completion Date': new Date().toISOString().split('T')[0],
            'Ops Status': 'Quality Check'
        };
        
        // Add Employee Link if we have employee info (it's a linked record field)
        if (employeeId) {
            updateFields['Employee Link'] = [employeeId];
        }
        
        console.log('Update fields:', JSON.stringify(updateFields));
        
        await base(ORDERS_TABLE).update(recordId, updateFields);

        // Re-fetch the record so Airtable formula fields (Base Pay, Per Item Pay, Total Order Pay) are current
        const freshRecord = await base(ORDERS_TABLE).find(recordId);
        const packageType = freshRecord.fields['Package Type'] || '';
        const basePay = freshRecord.fields['Base Pay'] != null
            ? freshRecord.fields['Base Pay']
            : getBasePayFallback(packageType);
        const perItemPay = freshRecord.fields['Per Item Pay'] != null
            ? freshRecord.fields['Per Item Pay']
            : itemsDigitized * PER_ITEM_PAY;
        const totalPay = freshRecord.fields['Total Order Pay'] != null
            ? freshRecord.fields['Total Order Pay']
            : basePay + perItemPay;
        
        console.log(`Order ${recordId} completed. Base: $${basePay}, PerItem: $${perItemPay}, Total: $${totalPay}`);
        
        res.json({
            success: true,
            order: { id: freshRecord.id, fields: freshRecord.fields },
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
