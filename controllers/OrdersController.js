const { query } = require("../config/db");
const midtransClient = require("midtrans-client");
const crypto = require("crypto");
const snap = new midtransClient.Snap({
  isProduction: false,
  serverKey: process.env.MIDTRANS_SERVER_KEY,
});

const createOrder = async (req, res) => {
  const { id } = req.user; // Ambil user_id dari payload JWT

  if (!id) {
    return res.status(400).json({ error: "User not authenticated" });
  }

  const { agrotourism_id, selected_date, quantity } = req.body;

  if (!agrotourism_id || !selected_date || !quantity) {
    return res.status(400).json({ error: "All fields are required" });
  }

  try {
    // Ambil harga tiket dari database
    const hashedToken = crypto.randomUUID();
    const [agroData] = await query(
      "SELECT price FROM agrotourism WHERE id = ?",
      [agrotourism_id]
    );

    if (!agroData || agroData.length === 0) {
      return res.status(404).json({ error: "Agrotourism not found" });
    }

    const ticketPrice = agroData.price;
    const total_price = ticketPrice * quantity; // Kalkulasi total harga

    // Generate order ID
    const order_id = `order-${Date.now()}`;

    // Insert into orders table
    await query(
      `INSERT INTO orders (order_id, user_id, agrotourism_id, selected_date, quantity, total_price, token)
         VALUES (?, ?, ?, ?, ?, ?,?)`,
      [
        order_id,
        id,
        agrotourism_id,
        selected_date,
        quantity,
        total_price,
        hashedToken,
      ]
    );

    // Insert into transactions table
    await query(
      `INSERT INTO transactions (order_id, amount, status) VALUES (?, ?, ?)`,
      [order_id, total_price, "pending"]
    );

    // Midtrans transaction processing
    const parameter = {
      transaction_details: {
        order_id: order_id,
        gross_amount: total_price,
      },
      customer_details: {
        first_name: "Customer Name", // Ganti sesuai data user
        email: "customer@example.com", // Ganti sesuai data user
        phone: "08123456789", // Ganti sesuai data user
      },
    };

    const transaction = await snap.createTransaction(parameter);

    res.status(201).json({
      message: "Order created successfully",
      hashedToken: hashedToken,
      token: transaction.token,
      order_id: order_id,
      total_price: total_price,
      // Kirim total harga ke frontend
    });
  } catch (error) {
    console.error("Error creating order:", error);
    return res.status(500).json({ error: "Failed to create order" });
  }
};

const handlePaymentCallback = async (req, res) => {
  const { transaction_status, order_id, status_code, signature_key } = req.body;

  if (!order_id || !transaction_status || !status_code || !signature_key) {
    return res.status(400).json({ error: "Invalid data received" });
  }

  // Validasi signature key
  const expectedKey = crypto
    .createHash("sha512")
    .update(`${order_id}${status_code}${process.env.MIDTRANS_SERVER_KEY}`)
    .digest("hex");

  if (signature_key !== expectedKey) {
    return res.status(403).json({ error: "Invalid signature key" });
  }

  let status;
  if (transaction_status === "capture" || transaction_status === "settlement") {
    status = "success";
  } else if (transaction_status === "pending") {
    status = "pending";
  } else {
    status = "failed";
  }

  try {
    const queryStr = "UPDATE transactions SET status = ? WHERE order_id = ?";
    const result = await query(queryStr, [status, order_id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    res
      .status(200)
      .json({ message: "Transaction status updated successfully" });
  } catch (err) {
    console.error("Error updating transaction status: ", err);
    res.status(500).json({ error: "Failed to update transaction status" });
  }
};

const getOrderDetails = async (req, res) => {
  const { hashedToken } = req.params;

  try {
    // Query untuk mendapatkan detail order berdasarkan token
    const orderQuery = `
      SELECT orders.order_id, orders.quantity, orders.total_price, orders.selected_date, agrotourism.name AS wisata_name, agrotourism.price AS wisata_price,transactions.status AS payment_status

      FROM orders
      JOIN agrotourism ON orders.agrotourism_id = agrotourism.id
      JOIN transactions ON orders.order_id = transactions.order_id
      WHERE orders.token = ?
    `;

    const order = await query(orderQuery, [hashedToken]);

    // Jika order tidak ditemukan
    if (order.length === 0) {
      return res.status(404).json({ msg: "Order tidak ditemukan" });
    }

    // Jika order ditemukan, kirimkan detailnya
    return res
      .status(200)
      .json({ msg: "Detail order berhasil ditemukan", data: order[0] });
  } catch (error) {
    console.error("Gagal mendapatkan detail order:", error);
    return res
      .status(500)
      .json({ msg: "Gagal mendapatkan detail order", error: error.message });
  }
};

module.exports = { createOrder, handlePaymentCallback, getOrderDetails };
