/**
 * Heritage Bank - Professional PDF Receipt Generator
 * Generates branded, professional receipts for transactions
 */

const PDFDocument = require('pdfkit');
const { Readable } = require('stream');

class ReceiptGenerator {
  static generate(transaction, user, options = {}) {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({
          size: 'A4',
          margin: 40
        });

        let chunks = [];
        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        // Header with logo and company info
        doc.fontSize(24).font('Helvetica-Bold').text('Heritage Bank', { align: 'center' });
        doc.fontSize(10).font('Helvetica').fillColor('#666').text('Professional Banking Solutions', { align: 'center' });
        doc.fontSize(9).fillColor('#999').text('Member FDIC | Equal Housing Lender', { align: 'center' });

        // Company contact info
        doc.moveTo(50, doc.y + 10).lineTo(550, doc.y + 10).stroke('#ddd');
        doc.fontSize(9).fillColor('#666');
        doc.text('📍 Heritage Bank Headquarters', 50, doc.y + 15);
        doc.text('📧 contact@heritagebank.com | 📞 1-800-HERITAGE', 50);
        doc.text('🌐 www.heritagebank.com | SWIFT: HBKUUS33', 50);

        doc.moveTo(50, doc.y + 10).lineTo(550, doc.y + 10).stroke('#ddd');

        // Transaction header
        doc.fontSize(14).font('Helvetica-Bold').fillColor('#1a472a').text('TRANSACTION RECEIPT', 50, doc.y + 20);

        // Transaction details in two columns
        const leftX = 50;
        const rightX = 300;
        const detailY = doc.y + 15;

        doc.fontSize(10).font('Helvetica-Bold').fillColor('#333');
        doc.text('Reference Number:', leftX, detailY);
        doc.fontSize(10).font('Helvetica').fillColor('#666').text(transaction.reference || `TXN-${transaction.id}`, rightX, detailY);

        doc.fontSize(10).font('Helvetica-Bold').fillColor('#333').text('Transaction Date:', leftX, doc.y + 15);
        doc.fontSize(10).font('Helvetica').fillColor('#666').text(this.formatDate(transaction.createdAt), rightX, doc.y - 15);

        doc.fontSize(10).font('Helvetica-Bold').fillColor('#333').text('Transaction Time:', leftX, doc.y + 15);
        doc.fontSize(10).font('Helvetica').fillColor('#666').text(this.formatTime(transaction.createdAt), rightX, doc.y - 15);

        doc.fontSize(10).font('Helvetica-Bold').fillColor('#333').text('Status:', leftX, doc.y + 15);
        const statusColor = transaction.status === 'completed' ? '#28a745' : '#f39c12';
        doc.fontSize(10).font('Helvetica-Bold').fillColor(statusColor).text(this.capitalizeFirst(transaction.status), rightX, doc.y - 15);

        doc.moveTo(50, doc.y + 15).lineTo(550, doc.y + 15).stroke('#ddd');

        // Transaction type and amount section
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#1a472a').text('TRANSACTION AMOUNT', 50, doc.y + 20);

        doc.fontSize(11).font('Helvetica').fillColor('#666').text(`Type: ${this.cleanType(transaction.type)}`, 50, doc.y + 10);

        const amountColor = transaction.type === 'credit' || transaction.toUserId === user.id ? '#28a745' : '#dc3545';
        const sign = transaction.type === 'credit' || transaction.toUserId === user.id ? '+' : '-';
        
        doc.fontSize(18).font('Helvetica-Bold').fillColor(amountColor).text(
          `${sign}$${parseFloat(transaction.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
          50,
          doc.y + 15
        );

        if (transaction.fee && parseFloat(transaction.fee) > 0) {
          doc.fontSize(10).font('Helvetica').fillColor('#666').text(
            `Transaction Fee: -$${parseFloat(transaction.fee).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
            50,
            doc.y + 10
          );
          const total = Math.abs(parseFloat(transaction.amount)) + parseFloat(transaction.fee);
          doc.fontSize(11).font('Helvetica-Bold').fillColor('#333').text(
            `Total: -$${total.toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
            50,
            doc.y + 10
          );
        }

        doc.moveTo(50, doc.y + 15).lineTo(550, doc.y + 15).stroke('#ddd');

        // Parties involved
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#1a472a').text('TRANSACTION DETAILS', 50, doc.y + 20);

        doc.fontSize(10).font('Helvetica-Bold').fillColor('#333').text('From Account:', 50, doc.y + 10);
        doc.fontSize(10).font('Helvetica').fillColor('#666').text(
          `${user.firstName} ${user.lastName} (${user.email})`,
          50,
          doc.y + 5
        );
        if (user.accountNumber) {
          doc.fontSize(9).fillColor('#999').text(`Account: ****${String(user.accountNumber).slice(-4)}`);
        }

        doc.fontSize(10).font('Helvetica-Bold').fillColor('#333').text('To Account:', 50, doc.y + 15);
        const toName = transaction.recipientName || 
          `${transaction.toFirstName || 'Recipient'} ${transaction.toLastName || 'Name'}`;
        doc.fontSize(10).font('Helvetica').fillColor('#666').text(toName, 50, doc.y + 5);
        if (transaction.toAccountNumber) {
          doc.fontSize(9).fillColor('#999').text(`Account: ****${String(transaction.toAccountNumber).slice(-4)}`);
        }

        doc.fontSize(10).font('Helvetica-Bold').fillColor('#333').text('Description:', 50, doc.y + 15);
        doc.fontSize(10).font('Helvetica').fillColor('#666').text(
          transaction.description || 'N/A',
          50,
          doc.y + 5,
          { width: 450 }
        );

        // Additional info if international
        if (transaction.destinationCountry || transaction.exchangeRate) {
          doc.moveTo(50, doc.y + 15).lineTo(550, doc.y + 15).stroke('#ddd');
          doc.fontSize(12).font('Helvetica-Bold').fillColor('#1a472a').text('INTERNATIONAL TRANSFER DETAILS', 50, doc.y + 20);

          if (transaction.destinationCountry) {
            doc.fontSize(10).font('Helvetica-Bold').fillColor('#333').text('Destination Country:', 50, doc.y + 10);
            doc.fontSize(10).font('Helvetica').fillColor('#666').text(transaction.destinationCountry, 50, doc.y + 5);
          }

          if (transaction.exchangeRate) {
            doc.fontSize(10).font('Helvetica-Bold').fillColor('#333').text('Exchange Rate:', 50, doc.y + 15);
            doc.fontSize(10).font('Helvetica').fillColor('#666').text(transaction.exchangeRate, 50, doc.y + 5);
          }

          if (transaction.recipientAmount) {
            doc.fontSize(10).font('Helvetica-Bold').fillColor('#333').text('Recipient Receives:', 50, doc.y + 15);
            const cur = transaction.recipientCurrency || 'USD';
            doc.fontSize(10).font('Helvetica').fillColor('#666').text(
              `${transaction.recipientAmount} ${cur}`,
              50,
              doc.y + 5
            );
          }
        }

        // Footer
        doc.moveTo(50, doc.y + 20).lineTo(550, doc.y + 20).stroke('#ddd');
        doc.fontSize(8).fillColor('#999').text(
          'This is an official receipt from Heritage Bank. Please keep for your records.',
          50,
          doc.y + 20,
          { align: 'center', width: 450 }
        );

        doc.fontSize(7).fillColor('#bbb').text(
          `Generated on ${new Date().toLocaleString('en-US')} | Confidential - For Account Holder Only`,
          50,
          doc.y + 15,
          { align: 'center', width: 450 }
        );

        doc.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  static formatDate(dateStr) {
    if (!dateStr) return 'N/A';
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  }

  static formatTime(dateStr) {
    if (!dateStr) return 'N/A';
    return new Date(dateStr).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  static capitalizeFirst(str) {
    return str ? str.charAt(0).toUpperCase() + str.slice(1).toLowerCase() : 'N/A';
  }

  static cleanType(type) {
    const map = {
      'direct_deposit': 'Direct Deposit',
      'admin_transfer': 'Transfer',
      'admin_debit': 'Debit',
      'admin_credit': 'Credit',
      'wire_transfer': 'Wire Transfer',
      'bank_transfer': 'Bank Transfer',
      'bill_payment': 'Bill Payment',
      'transfer': 'Transfer',
      'credit': 'Credit',
      'debit': 'Debit'
    };
    return map[(type || '').toLowerCase()] || this.capitalizeFirst(type);
  }
}

module.exports = ReceiptGenerator;
