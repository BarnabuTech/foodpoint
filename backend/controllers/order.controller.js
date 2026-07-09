import dotenv from "dotenv";
dotenv.config();
import Shop from "../models/shop.model.js";
import Order from "../models/order.model.js";
import User from "../models/user.model.js";
import deliveryAssignment from "../models/deliveryAssignment.model.js";
import { sendDeliveryOtp } from "../utils/mail.js";
import axios from "axios";

// M-Pesa Configuration
const MPESA_CONFIG = {
  consumerKey: process.env.MPESA_CONSUMER_KEY,
  consumerSecret: process.env.MPESA_CONSUMER_SECRET,
  shortcode: process.env.MPESA_SHORTCODE,
  passkey: process.env.MPESA_PASSKEY,
  baseUrl: process.env.MPESA_ENV === 'production' 
    ? 'https://api.safaricom.co.ke' 
    : 'https://sandbox.safaricom.co.ke'
};

// Get M-Pesa Access Token
const getMpesaAccessToken = async () => {
  const auth = Buffer.from(`${MPESA_CONFIG.consumerKey}:${MPESA_CONFIG.consumerSecret}`).toString('base64');
  const tokenUrl = process.env.MPESA_ENV === 'production' 
    ? 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
    : 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';
  
  try {
    const response = await axios.get(tokenUrl, {
      headers: {
        'Authorization': `Basic ${auth}`
      }
    });
    return response.data.access_token;
  } catch (error) {
    console.error('M-Pesa auth error:', error.response?.data || error.message);
    throw new Error('Failed to get M-Pesa access token');
  }
};

// Generate M-Pesa Password
const generateMpesaPassword = () => {
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3);
  const password = Buffer.from(`${MPESA_CONFIG.shortcode}${MPESA_CONFIG.passkey}${timestamp}`).toString('base64');
  return { password, timestamp };
};

export const placeOrder = async (req, res) => {
  try {
    const { cartItems, paymentMethod, deliveryAddress, totalAmount, phoneNumber } = req.body;
    if (cartItems.length === 0 || !cartItems) {
      return res.status(400).json({ message: "Cart is empty" });
    }

    if (
      !deliveryAddress.text ||
      !deliveryAddress.latitude ||
      !deliveryAddress.longitude
    ) {
      return res.status(400).json({ message: "Delivery address is required" });
    }

    if (paymentMethod === "online" && !phoneNumber) {
      return res.status(400).json({ message: "Phone number is required for M-Pesa payment" });
    }

    const groupItemByShop = {};

    cartItems.forEach((item) => {
      const shopId = item.shop;
      if (!groupItemByShop[shopId]) {
        groupItemByShop[shopId] = [];
      }
      groupItemByShop[shopId].push(item);
    });

    const shopOrders = await Promise.all(
      Object.keys(groupItemByShop).map(async (shopId) => {
        const shop = await Shop.findById(shopId).populate("owner");
        if (!shop) {
          return res.status(400).json({ message: "Shop not found!" });
        }
        const items = groupItemByShop[shopId];
        const subTotal = items.reduce(
          (sum, i) => sum + Number(i.price) * Number(i.quantity),
          0
        );
        return {
          shop: shop._id,
          owner: shop.owner._id,
          subTotal,
          shopOrderItems: items.map((i) => ({
            item: i.id,
            price: i.price,
            quantity: i.quantity,
            name: i.name,
          })),
        };
      })
    );

    if (paymentMethod === "online") {
      // Initiate M-Pesa STK Push
      const accessToken = await getMpesaAccessToken();
      const { password, timestamp } = generateMpesaPassword();
      
      const stkPushData = {
        BusinessShortCode: MPESA_CONFIG.shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: Math.round(totalAmount),
        PartyA: phoneNumber,
        PartyB: MPESA_CONFIG.shortcode,
        PhoneNumber: phoneNumber,
        CallBackURL: `${process.env.BASE_URL}/api/order/verify-payment`,
        AccountReference: `FoodPoint-${Date.now()}`,
        TransactionDesc: "Food Order Payment"
      };

      try {
        const stkResponse = await axios.post(
          `${MPESA_CONFIG.baseUrl}/mpesa/stkpush/v1/processrequest`,
          stkPushData,
          {
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            }
          }
        );

        const newOrder = await Order.create({
          user: req.userId,
          paymentMethod,
          deliveryAddress,
          totalAmount,
          shopOrders,
          mpesaCheckoutRequestId: stkResponse.data.CheckoutRequestID,
          payment: false,
        });

        return res.status(201).json({
          checkoutRequestId: stkResponse.data.CheckoutRequestID,
          orderId: newOrder._id,
          message: "STK Push sent to your phone. Please complete the payment."
        });
      } catch (error) {
        console.error('❌ M-Pesa STK Push Error:');
        console.error('Error message:', error.message);
        console.error('Error response:', error.response?.data);
        console.error('Error status:', error.response?.status);
        return res.status(500).json({ 
          message: "Failed to initiate M-Pesa payment", 
          error: error.message,
          details: error.response?.data 
        });
      }
    }

    const newOrder = await Order.create({
      user: req.userId,
      paymentMethod,
      deliveryAddress,
      totalAmount,
      shopOrders,
    });

    await newOrder.populate(
      "shopOrders.shopOrderItems.item",
      "name image price"
    );
    await newOrder.populate("shopOrders.shop", "name");
    await newOrder.populate("shopOrders.owner", "name socketId");
    await newOrder.populate("user", "fullName email mobile");

    const io = req.app.get("io");

    if (io) {
      newOrder.shopOrders.forEach((shopOrder) => {
        const ownerSocketId = shopOrder.owner.socketId;
        if (ownerSocketId) {
          io.to(ownerSocketId).emit("newOrder", {
            _id: newOrder._id,
            paymentMethod: newOrder.paymentMethod,
            user: newOrder.user,
            shopOrders: [shopOrder], // Fixed: Wrap in array to match expected structure
            createdAt: newOrder.createdAt,
            deliveryAddress: newOrder.deliveryAddress,
            payment: newOrder.payment,
            totalAmount: newOrder.totalAmount,
          });
        }
      });
    }

    return res.status(201).json(newOrder);
  } catch (error) {
    return res
      .status(500)
      .json({ message: `Place order error ${error.message}` });
  }
};

export const verifyPayment = async (req, res) => {
  try {
    // M-Pesa sends callback data in req.body
    const callbackData = req.body;
    
    // Check if payment was successful
    if (callbackData.Body?.stkCallback?.ResultCode !== 0) {
      return res.status(400).json({ message: "Payment not successful" });
    }

    const checkoutRequestId = callbackData.Body.stkCallback.CheckoutRequestID;
    const order = await Order.findOne({ mpesaCheckoutRequestId: checkoutRequestId });
    
    if (!order) {
      return res.status(400).json({ message: "Order not found!" });
    }
    
    order.payment = true;
    order.mpesaReceiptNumber = callbackData.Body.stkCallback.CallbackMetadata?.Item?.find(item => item.Name === 'MpesaReceiptNumber')?.Value;
    await order.save();

    await order.populate("shopOrders.shopOrderItems.item", "name image price");
    await order.populate("shopOrders.shop", "name");
    await order.populate("shopOrders.owner", "name socketId");
    await order.populate("user", "fullName email mobile");

    // Emit socket event for online payment orders
    const io = req.app.get("io");
    if (io) {
      order.shopOrders.forEach((shopOrder) => {
        const ownerSocketId = shopOrder.owner.socketId;
        if (ownerSocketId) {
          io.to(ownerSocketId).emit("newOrder", {
            _id: order._id,
            paymentMethod: order.paymentMethod,
            user: order.user,
            shopOrders: [shopOrder], // Wrap in array to match expected structure
            createdAt: order.createdAt,
            deliveryAddress: order.deliveryAddress,
            payment: order.payment,
            totalAmount: order.totalAmount,
          });
        }
      });
    }

    return res.status(200).json(order);
  } catch (error) {
    return res
      .status(500)
      .json({ message: `Verify payment error ${error.message}` });
  }
};

export const getMyOrders = async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(400).json({ message: "User not found!" });
    }

    if (user.role == "user") {
      const orders = await Order.find({ user: req.userId })
        .sort({ createdAt: -1 })
        .populate("shopOrders.shop", "name")
        .populate("shopOrders.owner", "name email mobile")
        .populate("shopOrders.shopOrderItems.item", "name image price");

      return res.status(200).json(orders);
    } else if (user.role == "owner") {
      const orders = await Order.find({ "shopOrders.owner": req.userId })
        .sort({ createdAt: -1 })
        .populate("user")
        .populate("shopOrders.shop", "name")
        .populate("shopOrders.shopOrderItems.item", "name image price")
        .populate("shopOrders.assignedDeliveryBoy", "fullName mobile");

      const filterOrders = orders.map((order) => ({
        _id: order._id,
        paymentMethod: order.paymentMethod,
        user: order.user,
        // Keep it as an array with only the owner's shop orders
        shopOrders: order.shopOrders.filter(
          (o) => String(o.owner._id) === String(req.userId)
        ),
        createdAt: order.createdAt,
        deliveryAddress: order.deliveryAddress,
        payment: order.payment,
        totalAmount: order.totalAmount,
      }));

      return res.status(200).json(filterOrders);
    }
  } catch (error) {
    return res
      .status(500)
      .json({ message: `Get user orders error ${error.message}` });
  }
};

export const updateOrderStatus = async (req, res) => {
  try {
    const { orderId, shopId } = req.params;
    const { status } = req.body;

    const order = await Order.findById(orderId);

    if (!order) {
      return res.status(400).json({ message: "Order not found!" });
    }

    const shopOrder = order.shopOrders.find(
      (so) => String(so.shop) === String(shopId)
    );

    if (!shopOrder) {
      return res.status(400).json({ message: "Shop order not found!" });
    }

    // ✅ Only clean up if moving away from preparing status
    if (
      shopOrder.status === "preparing" &&
      status !== "preparing" &&
      shopOrder.assignment
    ) {
      // Cancel the assignment and notify all delivery boys
      const assignment = await deliveryAssignment.findById(
        shopOrder.assignment
      );
      if (assignment) {
        assignment.status = "cancelled";
        await assignment.save();

        // Emit cancellation to all delivery boys
        const io = req.app.get("io");
        if (io) {
          const deliveryBoys = await User.find({
            _id: { $in: assignment.broadcastedTo },
            socketId: { $exists: true, $ne: null },
          });

          deliveryBoys.forEach((boy) => {
            if (boy.socketId) {
              io.to(boy.socketId).emit("assignmentCancelled", {
                assignmentId: assignment._id,
                reason: "Order status changed by restaurant",
              });
            }
          });
        }
      }
      shopOrder.assignment = null;
    }

    shopOrder.status = status;
    let deliveryBoyPayload = [];

    // ✅ CHANGED: Create assignment for preparing status
    if (status === "preparing") {
      const { latitude, longitude } = order.deliveryAddress;

      // ✅ Check if coordinates are valid
      if (!latitude || !longitude || latitude === 0 || longitude === 0) {
        return res.status(400).json({
          message:
            "Invalid customer delivery coordinates. Cannot search for delivery boys.",
          shopOrder,
          availableBoys: [],
        });
      }

      console.log(`🔍 Searching for delivery boys near customer at [${longitude}, ${latitude}]`);
      
      // ✅ Progressive radius search: 20km → 50km → 100km
      let nearByDeliveryBoys = [];
      const searchRadii = [20000, 50000, 100000]; // 20km, 50km, 100km
      
      for (const radius of searchRadii) {
        console.log(`  📏 Trying radius: ${radius/1000}km...`);
        nearByDeliveryBoys = await User.find({
          role: "deliveryBoy",
          isAvailable: true,
          location: {
            $near: {
              $geometry: {
                type: "Point",
                coordinates: [Number(longitude), Number(latitude)],
              },
              $maxDistance: radius,
            },
          },
        })
          .select('_id fullName email mobile location socketId')
          .limit(20)
          .lean();
        
        console.log(`  📊 Found: ${nearByDeliveryBoys.length} delivery boys`);
        
        if (nearByDeliveryBoys.length > 0) {
          console.log(`✅ Found ${nearByDeliveryBoys.length} delivery boys within ${radius/1000}km`);
          break;
        }
      }

      // ✅ Debug: Check total delivery boys in system
      const totalDeliveryBoys = await User.countDocuments({ role: "deliveryBoy" });
      const availableDeliveryBoys = await User.countDocuments({ role: "deliveryBoy", isAvailable: true });
      console.log(`📈 Total delivery boys: ${totalDeliveryBoys}, Available: ${availableDeliveryBoys}`);

      if (nearByDeliveryBoys.length === 0) {
        await order.save();
        console.log(`⚠️ No delivery boys found within 100km of [${latitude}, ${longitude}]`);
        console.log(`   📍 Customer location: ${latitude}, ${longitude} (Mombasa area)`);
        console.log(`   🔧 Make sure delivery boys have location coordinates set near this area!`);
        return res.status(200).json({
          shopOrder,
          availableBoys: [],
          message:
            "⚠️ No delivery boys found within 100km. Ensure delivery boys are logged in with location enabled near Mombasa.",
        });
      }

      // ✅ Check for busy delivery boys (optimized with select and lean)
      const nearByIds = nearByDeliveryBoys.map((b) => b._id);
      console.log(`📍 Found ${nearByDeliveryBoys.length} delivery boys within 20km`);
      
      const busyIds = await deliveryAssignment
        .find({
          assignedTo: { $in: nearByIds },
          status: { $nin: ["broadcast", "delivered", "cancelled"] },
        })
        .select('assignedTo')
        .lean()
        .distinct("assignedTo");

      const busyIdSet = new Set(busyIds.map((id) => String(id)));
      const availableBoys = nearByDeliveryBoys.filter(
        (b) => !busyIdSet.has(String(b._id))
      );

      const candidates = availableBoys.map((b) => b._id);

      if (candidates.length === 0) {
        await order.save();
        return res.status(200).json({
          shopOrder,
          availableBoys: [],
          message: "All nearby delivery boys are currently busy.",
        });
      }

      // ✅ Create NEW assignment (don't delete previous ones)
      const newAssignment = await deliveryAssignment.create({
        order: order._id,
        shop: shopOrder.shop,
        shopOrderId: shopOrder._id,
        broadcastedTo: candidates,
        status: "broadcast",
        createdAt: new Date(),
      });

      shopOrder.assignment = newAssignment._id;
      await order.save(); // Save immediately so response doesn't wait

      // ✅ Format delivery boy payload for immediate response
      deliveryBoyPayload = availableBoys.map((b) => ({
        id: b._id,
        name: b.fullName,
        longitude: b.location?.coordinates?.[0],
        latitude: b.location?.coordinates?.[1],
        email: b.email,
        mobile: b.mobile,
      }));

      // ✅ Async notification - don't block response
      (async () => {
        try {
          await newAssignment.populate("order");
          await newAssignment.populate("shop");

          const io = req.app.get("io");
          if (io) {
            const assignmentData = {
              assignmentId: newAssignment._id,
              orderId: newAssignment.order._id,
              shopOrderId: newAssignment.shopOrderId,
              shopName: newAssignment.shop.name,
              shopAddress: newAssignment.shop.address,
              deliveryAddress: newAssignment.order.deliveryAddress,
              items:
                newAssignment.order.shopOrders.find(
                  (so) => String(so._id) === String(newAssignment.shopOrderId)
                )?.shopOrderItems || [],
              subTotal:
                newAssignment.order.shopOrders.find(
                  (so) => String(so._id) === String(newAssignment.shopOrderId)
                )?.subTotal || 0,
              totalAmount: newAssignment.order.totalAmount,
              placedAt: newAssignment.createdAt,
              customer: {
                name: newAssignment.order.user.fullName,
                mobile: newAssignment.order.user.mobile,
              },
              status: newAssignment.status,
              paymentMethod: newAssignment.order.paymentMethod,
            };

            // Send to each delivery boy individually
            availableBoys.forEach((boy) => {
              const boySocketId = boy.socketId;
              if (boySocketId) {
                io.to(boySocketId).emit("newAssignment", {
                  sentTo: boy._id,
                  ...assignmentData,
                });
                console.log(
                  `📡 NEW ASSIGNMENT SENT TO: ${boy.fullName} (${boy.mobile})`
                );
              }
            });
          }
        } catch (err) {
          console.error("❌ Async notification error:", err);
        }
      })(); // Fire and forget - don't await
    }

    // ✅ Populate for response (skip if already populated in preparing block)
    await order.populate("shopOrders.shop", "name");
    await order.populate(
      "shopOrders.assignedDeliveryBoy",
      "fullName email mobile"
    );
    await order.populate("user", "socketId");

    const updatedShopOrder = order.shopOrders.find(
      (so) => String(so.shop._id) === String(shopId)
    );

    // ✅ Emit status update to user
    const io = req.app.get("io");
    if (io) {
      const userSocketId = order.user.socketId;
      if (userSocketId) {
        io.to(userSocketId).emit("updateStatus", {
          orderId: order._id,
          shopId: updatedShopOrder.shop._id,
          status: updatedShopOrder.status,
          userId: order.user._id,
        });
        console.log("📡 STATUS UPDATE SENT TO USER");
      }
    }

    return res.status(200).json({
      shopOrder: updatedShopOrder,
      assignedDeliveryBoy: updatedShopOrder?.assignedDeliveryBoy,
      availableBoys: deliveryBoyPayload,
      assignmentId: updatedShopOrder?.assignment,
      message: "Order status updated successfully",
    });
  } catch (error) {
    console.error("❌ UPDATE ORDER STATUS ERROR:", error);
    return res.status(500).json({
      message: `Update order status error ${error.message}`,
    });
  }
};

// ✅ UPDATED: Get all active assignments for delivery boy
export const getDeliveryBoyAssignment = async (req, res) => {
  try {
    const deliveryBoyId = req.userId;

    // ✅ Get ALL broadcast assignments for this delivery boy
    const assignments = await deliveryAssignment
      .find({
        broadcastedTo: deliveryBoyId,
        status: "broadcast", // Only show active assignments
      })
      .sort({ createdAt: -1 }) // Latest first
      .populate("order")
      .populate("shop");

    // ✅ Format all assignments
    const formatted = assignments.map((a) => ({
      assignmentId: a._id,
      orderId: a.order._id,
      shopOrderId: a.shopOrderId,
      shopName: a.shop.name,
      shopAddress: a.shop.address,
      deliveryAddress: a.order.deliveryAddress,
      items:
        a.order.shopOrders.find(
          (so) => String(so._id) === String(a.shopOrderId)
        )?.shopOrderItems || [],
      subTotal:
        a.order.shopOrders.find(
          (so) => String(so._id) === String(a.shopOrderId)
        )?.subTotal || 0,
      totalAmount: a.order.totalAmount,
      status: a.status,
      placedAt: a.createdAt,
      customer: {
        name: a.order.user.fullName,
        mobile: a.order.user.mobile,
      },
      paymentMethod: a.order.paymentMethod,
    }));

    console.log(
      `📋 DELIVERY BOY ${deliveryBoyId} HAS ${formatted.length} ACTIVE ASSIGNMENTS`
    );

    return res.status(200).json(formatted);
  } catch (error) {
    return res.status(500).json({
      message: `Get delivery boy assignment error ${error.message}`,
    });
  }
};

// ✅ UPDATED: Accept order and remove from all other delivery boys
export const acceptOrder = async (req, res) => {
  try {
    const { assignmentId } = req.params;

    const assignment = await deliveryAssignment.findById(assignmentId);
    if (!assignment) {
      return res.status(400).json({ message: "Assignment not found!" });
    }

    if (assignment.status !== "broadcast") {
      return res
        .status(400)
        .json({ message: "Assignment is no longer available!" });
    }

    // ✅ Check if delivery boy already has an active assignment
    const alreadyAssignment = await deliveryAssignment.findOne({
      assignedTo: req.userId,
      status: { $nin: ["broadcast", "delivered", "cancelled"] },
    });

    if (alreadyAssignment) {
      return res.status(400).json({
        message: "You already have an active assignment!",
      });
    }

    // ✅ Accept the assignment
    assignment.assignedTo = req.userId;
    assignment.status = "assigned";
    assignment.acceptedAt = new Date();
    await assignment.save();

    // ✅ Update the order
    const order = await Order.findById(assignment.order);
    if (!order) {
      return res.status(400).json({ message: "Order not found!" });
    }

    const shopOrder = order.shopOrders.find(
      (so) => String(so._id) === String(assignment.shopOrderId)
    );
    if (!shopOrder) {
      return res.status(400).json({ message: "Shop order not found!" });
    }

    shopOrder.assignedDeliveryBoy = req.userId;
    await order.save();

    // ✅ IMPORTANT: Notify ALL other delivery boys that this assignment is taken
    const io = req.app.get("io");
    if (io) {
      const otherDeliveryBoys = await User.find({
        _id: { $in: assignment.broadcastedTo, $ne: req.userId },
        socketId: { $exists: true, $ne: null },
      });

      otherDeliveryBoys.forEach((boy) => {
        if (boy.socketId) {
          io.to(boy.socketId).emit("assignmentTaken", {
            assignmentId: assignment._id,
            takenBy: req.userId,
            message: "This order has been accepted by another delivery partner",
          });
          console.log(
            `📡 ASSIGNMENT TAKEN NOTIFICATION SENT TO: ${boy.fullName}`
          );
        }
      });

      // ✅ Notify the accepting delivery boy
      const acceptingBoy = await User.findById(req.userId);
      if (acceptingBoy.socketId) {
        io.to(acceptingBoy.socketId).emit("assignmentAccepted", {
          assignmentId: assignment._id,
          orderId: order._id,
          message: "Order accepted successfully!",
        });
      }
    }

    await order.populate("shopOrders.shop", "name");
    await order.populate(
      "shopOrders.assignedDeliveryBoy",
      "fullName email mobile"
    );

    console.log(
      `✅ ORDER ACCEPTED BY: ${req.userId} for assignment: ${assignmentId}`
    );

    return res.status(200).json({
      message: "Order accepted successfully!",
      assignmentId: assignment._id,
      orderId: order._id,
    });
  } catch (error) {
    return res.status(500).json({
      message: `Accept order error ${error.message}`,
    });
  }
};

export const getCurrentOrder = async (req, res) => {
  try {
    console.log(
      `🔍 Searching for current order for delivery boy: ${req.userId}`
    );

    // First, let's see all assignments for this delivery boy
    const allAssignments = await deliveryAssignment.find({
      assignedTo: req.userId,
    });
    console.log(
      `📋 Total assignments for delivery boy: ${allAssignments.length}`
    );
    allAssignments.forEach((a) => {
      console.log(
        `  - Assignment ${a._id}: status=${a.status}, order=${a.order}`
      );
    });

    const assignedDeliveryBoyForOrder = await deliveryAssignment
      .findOne({
        assignedTo: req.userId,
        status: { $in: ["assigned", "out_for_delivery"] },
      })
      .populate("shop", "name address")
      .populate("assignedTo", "fullName email mobile location")
      .populate({
        path: "order",
        populate: [{ path: "user", select: "fullName email mobile location" }],
        paymentMethod: "paymentMethod",
      });

    if (!assignedDeliveryBoyForOrder) {
      console.log(`❌ No current order found for delivery boy: ${req.userId}`);
      console.log(
        `   Searched for status in: ["assigned", "out_for_delivery"]`
      );
      return res.status(400).json({
        message: "No current order found!",
        debug: {
          searchedUserId: req.userId,
          searchedStatuses: ["assigned", "out_for_delivery"],
          totalAssignmentsFound: allAssignments.length,
        },
      });
    }

    console.log(`✅ Found current order for delivery boy: ${req.userId}`);

    if (!assignedDeliveryBoyForOrder.order) {
      return res.status(400).json({ message: "Order not found!" });
    }

    const shopOrder = assignedDeliveryBoyForOrder.order.shopOrders.find(
      (so) => String(so._id) === String(assignedDeliveryBoyForOrder.shopOrderId)
    );

    if (!shopOrder) {
      return res.status(400).json({ message: "Shop order not found!" });
    }

    let deliveryBoyLocation = { lat: null, lon: null };

    if (
      assignedDeliveryBoyForOrder.assignedTo.location?.coordinates?.length == 2
    ) {
      deliveryBoyLocation.lat =
        assignedDeliveryBoyForOrder.assignedTo.location?.coordinates[1];
      deliveryBoyLocation.lon =
        assignedDeliveryBoyForOrder.assignedTo.location?.coordinates[0];
    }

    let customerLocation = { lat: null, lon: null };
    if (assignedDeliveryBoyForOrder.order.deliveryAddress) {
      customerLocation.lat =
        assignedDeliveryBoyForOrder.order.deliveryAddress.latitude;
      customerLocation.lon =
        assignedDeliveryBoyForOrder.order.deliveryAddress.longitude;
    }

    return res.status(200).json({
      _id: assignedDeliveryBoyForOrder.order._id,
      user: assignedDeliveryBoyForOrder.order.user,
      shopOrder: shopOrder,
      deliveryBoyLocation: deliveryBoyLocation,
      customerLocation: customerLocation,
      shop: assignedDeliveryBoyForOrder.shop,
      paymentMethod: assignedDeliveryBoyForOrder.order.paymentMethod,
      deliveryAddress: assignedDeliveryBoyForOrder.order.deliveryAddress,
      assignmentStatus: assignedDeliveryBoyForOrder.status,
      orderId: assignedDeliveryBoyForOrder.order._id,
      shopOrderId: assignedDeliveryBoyForOrder.shopOrderId,
    });
  } catch (error) {
    return res
      .status(500)
      .json({ message: `Get current order error ${error.message}` });
  }
};

export const getOrderById = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await Order.findById(orderId)
      .populate("user")
      .populate({
        path: "shopOrders.shop",
        model: "Shop",
      })
      .populate({
        path: "shopOrders.assignedDeliveryBoy",
        model: "User",
      })
      .populate({
        path: "shopOrders.shopOrderItems.item",
        model: "Item",
      })
      .lean();

    if (!order) {
      return res.status(400).json({ message: "Order not found!" });
    }
    return res.status(200).json(order);
  } catch (error) {
    return res
      .status(500)
      .json({ message: `Get order by id error ${error.message}` });
  }
};

// ...existing code...

export const sendDeliveryBoyOtp = async (req, res) => {
  try {
    const { orderId, shopOrderId } = req.body;
    
    const order = await Order.findById(orderId)
      .populate("user")
      .populate({
        path: "shopOrders.shop",
        select: "name"
      })
      .populate({
        path: "shopOrders.shopOrderItems.item", 
        select: "name price"
      });
      
    if (!order) {
      return res.status(400).json({ message: "Order not found!" });
    }
    
    const shopOrder = order.shopOrders.find(
      (so) => String(so._id) === String(shopOrderId)
    );
    
    if (!shopOrder) {
      return res.status(400).json({ message: "Shop order not found!" });
    }

    const otp = Math.floor(100000 + Math.random() * 900000);
    shopOrder.deliveryOtp = String(otp);
    shopOrder.otpExpires = new Date(Date.now() + 20 * 60 * 1000); // 20 minutes from now
    
    // Prepare order details for email
    const orderDetails = {
      orderId: order._id.toString(),
      subTotal: shopOrder.subTotal,
      items: shopOrder.shopOrderItems.map(item => ({
        name: item.item.name,
        price: item.item.price,
        quantity: item.quantity
      })),
      shopName: shopOrder.shop.name,
      deliveryAddress: order.deliveryAddress.text,
      paymentMethod: order.paymentMethod
    };
    
    await order.save();
    await sendDeliveryOtp(order.user, otp, orderDetails);
    
    return res.status(200).json({
      message: `Delivery otp sent successfully to ${order.user.fullName} - ${order.user.email}`,
    });
  } catch (error) {
    return res
      .status(500)
      .json({ message: `Send delivery otp error ${error.message}` });
  }
};

export const verifyDeliveryOtp = async (req, res) => {
  try {
    const { orderId, shopOrderId, otp } = req.body;
    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(400).json({ message: "Order not found!" });
    }
    const shopOrder = order.shopOrders.find(
      (so) => String(so._id) === String(shopOrderId)
    );
    if (!shopOrder) {
      return res.status(400).json({ message: "Shop order not found!" });
    }
    if (shopOrder.deliveryOtp !== otp || shopOrder.otpExpires < Date.now()) {
      return res.status(400).json({ message: "Invalid/Expired OTP" });
    }
    shopOrder.status = "delivered";
    shopOrder.deliveredAt = new Date();
    await order.save();
    await deliveryAssignment.deleteOne({
      shopOrderId: shopOrder._id,
      order: order._id,
      assignedTo: shopOrder.assignedDeliveryBoy,
    });

    return res.status(200).json({ message: "Order delivered successfully." });
  } catch (error) {
    return res
      .status(500)
      .json({ message: `Verify delivery otp error ${error.message}` });
  }
};

// Update delivery status for delivery boy actions
export const updateDeliveryStatus = async (req, res) => {
  try {
    const { orderId, shopOrderId, status } = req.body;
    const deliveryBoyId = req.userId;

    // Find the assignment
    const assignment = await deliveryAssignment
      .findOne({
        order: orderId,
        shopOrderId: shopOrderId,
        assignedTo: deliveryBoyId,
        status: { $ne: "delivered" },
      })
      .populate("order")
      .populate("shop")
      .populate("assignedTo", "fullName mobile");

    if (!assignment) {
      return res.status(404).json({
        success: false,
        message: "Assignment not found or already completed",
      });
    }

    // Find the order and shop order
    const order = await Order.findById(orderId).populate(
      "user",
      "socketId fullName"
    );
    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const shopOrder = order.shopOrders.find(
      (so) => String(so._id) === String(shopOrderId)
    );
    if (!shopOrder) {
      return res.status(404).json({
        success: false,
        message: "Shop order not found",
      });
    }

    // Handle status transitions
    if (status === "out of delivery") {
      if (assignment.status !== "assigned") {
        return res.status(400).json({
          success: false,
          message: "Order must be accepted first to mark as out for delivery",
        });
      }

      // Update assignment status
      assignment.status = "out_for_delivery";
      assignment.outForDeliveryAt = new Date();
      await assignment.save();

      // Update shop order status
      shopOrder.status = "out of delivery";
      await order.save();

      // Emit to customer for live tracking
      const io = req.app.get("io");
      if (io && order.user.socketId) {
        io.to(order.user.socketId).emit("orderStatusUpdate", {
          orderId: orderId,
          shopOrderId: shopOrderId,
          status: "out of delivery",
          message: "Your order is out for delivery!",
          deliveryBoy: {
            name: assignment.assignedTo.fullName,
            mobile: assignment.assignedTo.mobile,
          },
        });
        console.log("📡 OUT FOR DELIVERY STATUS SENT TO CUSTOMER");
      }

      return res.status(200).json({
        success: true,
        message: "Order marked as out for delivery successfully!",
      });
    }

    return res.status(400).json({
      success: false,
      message: "Invalid status transition",
    });
  } catch (error) {
    console.error("❌ UPDATE DELIVERY STATUS ERROR:", error);
    return res.status(500).json({
      success: false,
      message: `Update delivery status error: ${error.message}`,
    });
  }
};



export const getTodayDeliveries = async (req, res) => {
  try {
    const deliveryBoyId = req.userId;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const orders = await Order.find({
      "shopOrders.assignedDeliveryBoy": deliveryBoyId,
      "shopOrders.status": "delivered",
      "shopOrders.deliveredAt": { $gte: startOfDay },
    }).lean();

    let todaysDeliveries = [];

    orders.forEach((order) => {
      order.shopOrders.forEach((shopOrder) => {
        if (
          String(shopOrder.assignedDeliveryBoy) === String(deliveryBoyId) &&
          shopOrder.status === "delivered" &&
          shopOrder.deliveredAt >= startOfDay
        ) {
          todaysDeliveries.push(shopOrder);
        }
      });
    });

    let stats = {};

    todaysDeliveries.forEach((shopOrder) => {
      const hour = new Date(shopOrder.deliveredAt).getHours();
      stats[hour] = (stats[hour] || 0) + 1;
    });

    let formattedStats = Object.keys(stats).map((hour) => ({
      hour: parseInt(hour),
      count: stats[hour],
    }));

    formattedStats.sort((a, b) => a.hour - b.hour);

    return res.status(200).json(formattedStats);
  } catch (error) {
    return res
      .status(500)
      .json({ message: `Get today deliveries error ${error.message}` });
  }
};
