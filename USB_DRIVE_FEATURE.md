# USB Drive Display Feature

## Overview
Added functionality to display USB drive information when checking in orders. The app now shows if a customer ordered USB drives and how many.

## Changes Made

### 1. Backend (server.js)
**Location:** `/api/orders/tracking/:trackingNumber` endpoint

**What was added:**
- Fetches Order Items linked to each order
- Checks Product Names for USB drives (searches for "usb" in product name)
- Counts total USB drive quantity
- Returns `USB Drive Count` field with the order data

**Code added:**
```javascript
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
```

### 2. Frontend (index.html)
**Location:** Check-In tab, order details screen

**What was added:**
- Purple-themed info card that displays when USB drives are ordered
- Shows USB drive count with proper singular/plural grammar
- Positioned between "Expected Items" and "Actual Items Received" sections

**Visual Design:**
- Purple border with glow effect
- USB drive icon (download icon)
- Clear messaging: "USB Drive Ordered"
- Shows count: "X USB drive(s) to include"

## How It Works

### Data Flow:
1. **User scans/enters tracking number**
2. **Backend looks up order** in Airtable
3. **Backend fetches Order Items** linked to that order
4. **Backend checks each item's Product Name** for "usb" (case-insensitive)
5. **Backend sums up quantities** of all USB drive products
6. **Backend returns order data** with `USB Drive Count` field
7. **Frontend displays purple card** if count > 0

### Airtable Structure:
- **Orders table** → has "Order Items" field (linked records)
- **Order Items table** → has "Product" field (linked to Products)
- **Order Items table** → has "Product Name" field (lookup from Products)
- **Order Items table** → has "Quantity" field (number)
- **Products table** → includes "Custom USB Drive" product

## Example Display

When an order has 2 USB drives:
```
┌─────────────────────────────────────┐
│  💾  USB Drive Ordered              │
│      2 USB drives to include        │
└─────────────────────────────────────┘
```

When an order has 1 USB drive:
```
┌─────────────────────────────────────┐
│  💾  USB Drive Ordered              │
│      1 USB drive to include         │
└─────────────────────────────────────┘
```

When an order has no USB drives:
- Card is not displayed (hidden)

## Benefits

✅ **Employees immediately see** if USB drives need to be included  
✅ **Reduces errors** - no more forgetting to include USB drives  
✅ **Clear visual indicator** with purple color scheme  
✅ **Proper grammar** - handles singular/plural correctly  
✅ **Non-intrusive** - only shows when relevant  

## Testing Checklist

### Test with USB Drive Order
- [ ] Scan an order that includes USB drive(s)
- [ ] Verify purple "USB Drive Ordered" card appears
- [ ] Verify correct count is displayed
- [ ] Verify singular "drive" for count of 1
- [ ] Verify plural "drives" for count > 1

### Test without USB Drive Order
- [ ] Scan an order with no USB drives
- [ ] Verify purple card does NOT appear
- [ ] Verify rest of check-in flow works normally

### Test Multiple USB Drives
- [ ] Scan an order with 2+ USB drives
- [ ] Verify count is correct
- [ ] Verify plural form is used

## Technical Notes

- **Case-insensitive search**: Searches for "usb" in lowercase
- **Handles arrays**: Product Name can be array or string (from lookup field)
- **Error handling**: If Order Items fetch fails, count defaults to 0
- **Performance**: Only fetches Order Items when order has them
- **Flexible**: Will catch any product with "USB" in the name

## Future Enhancements

Potential improvements:
- Show USB drive info in "My Work" tab
- Add USB drive reminder on completion screen
- Track if USB drive was actually included
- Add checkbox to confirm USB drive inclusion

## Files Modified

1. **server.js** - Added USB drive detection logic
2. **index.html** - Added USB drive display card
3. **USB_DRIVE_FEATURE.md** - This documentation

---

**Date:** February 14, 2026  
**Status:** ✅ Complete - Ready for deployment
