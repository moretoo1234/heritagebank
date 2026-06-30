-- SQL script to manually create the cards table if it doesn't exist
-- Run this directly on your database to ensure the table exists

CREATE TABLE IF NOT EXISTS cards (
  id INT PRIMARY KEY AUTO_INCREMENT,
  userId INT NOT NULL,
  cardType VARCHAR(20) NOT NULL DEFAULT 'virtual',
  cardNumber VARCHAR(255),
  cardNumberMasked VARCHAR(30),
  cardholderName VARCHAR(255),
  expirationDate VARCHAR(10),
  cvv VARCHAR(10),
  status VARCHAR(20) DEFAULT 'active',
  deliveryStatus VARCHAR(30) DEFAULT 'not_applicable',
  deliveryAddress TEXT,
  deliveryEtaText VARCHAR(100),
  dailyLimit DECIMAL(12,2) DEFAULT 5000,
  monthlyLimit DECIMAL(12,2) DEFAULT 25000,
  onlineEnabled TINYINT(1) DEFAULT 1,
  internationalEnabled TINYINT(1) DEFAULT 0,
  issuedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (userId) REFERENCES users(id),
  INDEX idx_userId (userId)
);

-- Verify table creation
SELECT 'Cards table created successfully' AS status;
