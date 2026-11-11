// Wallet rules for passing a gate without enough balance.
module.exports = {
  // A driver may pass with a low balance and go down to -20 EGP (paid back automatically on the next top-up).
  OVERDRAFT_LIMIT: 20,
  // Passing when the toll would take the balance below -20 EGP: the toll is not taken and a 50 EGP fine is added.
  LATE_FINE: 50,
};
