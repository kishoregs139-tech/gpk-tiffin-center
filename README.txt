# GPK TIFFIN CENTER — Mobile Billing Prototype

## What's included
- Three separate in-app pages: food selection, bill summary, payment.
- Menu and prices transcribed from the supplied menu image.
- Quantity controls and automatic totals.
- Bill reference and a dynamic-QR integration placeholder.
- Demo-only payment button clearly states that no money was received.

## Run it
1. Download and unzip `GPK_Tiffin_Center_Billing_App.zip`.
2. Open the extracted folder.
3. Double-click `index.html` to open it in a browser.
4. On a phone, upload the folder to a static website host or run a local web server on your computer and open the computer's local-network address from the phone. For a simple first test, desktop browser responsive mode also works.

No install/build command is required for the frontend prototype.

## Important payment limitation
This prototype does NOT generate a real dynamic UPI QR code and does NOT verify real payments. The supplied static QR image is not embedded because it cannot enforce the bill amount. The app currently shows a placeholder on Page 3.

For live payments:
1. Open a merchant account with a payment provider that supports amount-specific UPI QR/payment requests.
2. Add a backend (server) that stores the secret API keys; never place secret keys in `app.js` or other browser code.
3. From Page 3, request a payment order/QR from your backend for the exact bill total and unique bill reference.
4. Display the QR returned by the provider.
5. Verify payment on the backend using a trusted provider webhook/API. Mark a bill as paid only after verification, and check amount/reference/status to prevent mismatched or duplicate payments.

The "Demo only: simulate paid" button intentionally does not mark a bill as genuinely paid.

## Menu
Dosa: Kal Dosa ₹20; Kal Nice ₹30; Egg Kal ₹40; Nice Dosa ₹40; Egg Dosa ₹60; Podi Dosa ₹60; Onion Dosa ₹70; Onion Uthapam ₹50; Ghee Dosa ₹70; Chicken Cari Dosa ₹150; Boti Dosa ₹150.

Parotta: Parotta ₹20; Veechu ₹40; Egg Veechu ₹60; Egg Kothu ₹100; Chicken Kothu ₹150; Chicken Chapati Kothu ₹150; Egg Chapati Kothu ₹100; Chicken Lappa ₹150; Egg Lappa ₹100.

Meat: Chicken Liver ₹100; Chicken Boti ₹130; Chinnamani Chicken ₹150; Pepper Chicken ₹150; Chettinad Chicken ₹150.

"Chinnamani Chicken" is transcribed from an unclear menu line; confirm spelling before production.
