<!-- Transaction Details Modal Script (Add to transactions.html) -->
<script>
    // Enhanced transaction details with PDF receipt download
    async function showTransactionDetails(transactionId) {
        const token = localStorage.getItem('token');
        const modal = document.getElementById('transactionModal') || createTransactionModal();
        
        try {
            // Fetch transaction details
            const response = await fetch(`${API_URL}/api/user/transactions`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });

            const data = await response.json();
            if (!data.success) throw new Error('Failed to load transactions');

            const transaction = data.transactions.find(t => t.id == transactionId);
            if (!transaction) throw new Error('Transaction not found');

            displayTransactionModal(transaction, modal);
            modal.style.display = 'block';
        } catch (e) {
            showAlert(`Error: ${e.message}`, 'error');
        }
    }

    function createTransactionModal() {
        const modal = document.createElement('div');
        modal.id = 'transactionModal';
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal-content transaction-modal">
                <div class="modal-header">
                    <h2>Transaction Details</h2>
                    <button class="close-btn" onclick="document.getElementById('transactionModal').style.display='none'">&times;</button>
                </div>
                <div class="modal-body" id="transactionDetails"></div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="document.getElementById('transactionModal').style.display='none'">Close</button>
                    <button class="btn btn-primary" id="downloadReceiptBtn" onclick="downloadReceipt()">📥 Download Receipt</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        return modal;
    }

    function displayTransactionModal(tx, modal) {
        const direction = tx.direction || (tx.toUserId ? 'credit' : 'debit');
        const isCredit = direction === 'credit';
        const sign = isCredit ? '+' : '-';
        const amountColor = isCredit ? '#28a745' : '#dc3545';

        const details = `
            <div class="transaction-detail-grid">
                <div class="detail-item">
                    <span class="detail-label">Reference Number</span>
                    <span class="detail-value">${tx.reference || `TXN-${tx.id}`}</span>
                </div>
                
                <div class="detail-item">
                    <span class="detail-label">Date & Time</span>
                    <span class="detail-value">${new Date(tx.createdAt).toLocaleString()}</span>
                </div>

                <div class="detail-item">
                    <span class="detail-label">Status</span>
                    <span class="detail-value status-${tx.status}">${tx.status || 'completed'}</span>
                </div>

                <div class="detail-item">
                    <span class="detail-label">Type</span>
                    <span class="detail-value">${cleanTransactionType(tx.type)}</span>
                </div>
            </div>

            <div class="transaction-amount-section" style="background: linear-gradient(135deg, ${amountColor}15 0%, ${amountColor}05 100%); padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid ${amountColor}">
                <div class="amount-label">Amount</div>
                <div class="amount-value" style="color: ${amountColor}; font-size: 32px; font-weight: 700;">
                    ${sign}$${parseFloat(tx.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </div>
                ${tx.fee && parseFloat(tx.fee) > 0 ? `
                    <div style="margin-top: 10px; font-size: 12px; color: #999;">
                        Fee: $${parseFloat(tx.fee).toFixed(2)}
                    </div>
                ` : ''}
            </div>

            <div class="transaction-parties">
                <div class="party-section">
                    <div class="party-label">From</div>
                    <div class="party-name">${tx.fromUserEmail || 'You'}</div>
                </div>
                <div class="arrow-icon">→</div>
                <div class="party-section">
                    <div class="party-label">To</div>
                    <div class="party-name">${tx.toUserEmail || tx.recipientName || 'Destination'}</div>
                </div>
            </div>

            ${tx.description ? `
                <div class="detail-section">
                    <div class="section-label">Description</div>
                    <div class="section-value">${tx.description}</div>
                </div>
            ` : ''}

            ${tx.destinationCountry ? `
                <div class="detail-section">
                    <div class="section-label">International Transfer</div>
                    <div class="section-value">
                        Destination: ${tx.destinationCountry}
                        ${tx.exchangeRate ? `<br>Exchange Rate: ${tx.exchangeRate}` : ''}
                        ${tx.recipientAmount ? `<br>Recipient Receives: ${tx.recipientAmount} ${tx.recipientCurrency || 'USD'}` : ''}
                    </div>
                </div>
            ` : ''}

            <div class="detail-section">
                <div class="section-label">Running Balance</div>
                <div class="section-value">
                    Before: $${parseFloat(tx.balanceBefore || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                    <br>
                    After: $${parseFloat(tx.balanceAfter || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </div>
            </div>

            <style>
                .transaction-detail-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                    gap: 15px;
                    margin-bottom: 20px;
                }

                .detail-item {
                    background: #f8f9fa;
                    padding: 15px;
                    border-radius: 8px;
                }

                .detail-label {
                    display: block;
                    font-size: 12px;
                    color: #999;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    font-weight: 600;
                    margin-bottom: 8px;
                }

                .detail-value {
                    display: block;
                    font-size: 16px;
                    font-weight: 600;
                    color: #1a472a;
                }

                .status-completed {
                    display: inline-block;
                    background: #d1e7dd;
                    color: #0f5132;
                    padding: 4px 12px;
                    border-radius: 12px;
                    font-size: 12px;
                    font-weight: 600;
                }

                .status-pending {
                    display: inline-block;
                    background: #fff3cd;
                    color: #856404;
                    padding: 4px 12px;
                    border-radius: 12px;
                    font-size: 12px;
                    font-weight: 600;
                }

                .transaction-amount-section {
                    text-align: center;
                }

                .amount-label {
                    font-size: 12px;
                    color: #999;
                    text-transform: uppercase;
                    margin-bottom: 10px;
                }

                .transaction-parties {
                    display: grid;
                    grid-template-columns: 1fr auto 1fr;
                    gap: 15px;
                    align-items: center;
                    background: #f8f9fa;
                    padding: 20px;
                    border-radius: 8px;
                    margin: 20px 0;
                }

                .party-section {
                    text-align: center;
                }

                .party-label {
                    font-size: 12px;
                    color: #999;
                    text-transform: uppercase;
                    margin-bottom: 8px;
                }

                .party-name {
                    font-size: 14px;
                    font-weight: 600;
                    color: #1a472a;
                    word-break: break-all;
                }

                .arrow-icon {
                    font-size: 20px;
                    color: #ddd;
                }

                .detail-section {
                    background: #f8f9fa;
                    padding: 15px;
                    border-radius: 8px;
                    margin: 15px 0;
                }

                .section-label {
                    font-size: 12px;
                    color: #999;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    font-weight: 600;
                    margin-bottom: 8px;
                }

                .section-value {
                    font-size: 14px;
                    color: #333;
                    line-height: 1.6;
                }
            </style>
        `;

        document.getElementById('transactionDetails').innerHTML = details;
        
        // Store transaction ID for receipt download
        document.getElementById('downloadReceiptBtn').dataset.transactionId = tx.id;
    }

    function cleanTransactionType(type) {
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
            'debit': 'Debit',
            'check_deposit': 'Check Deposit',
            'investment': 'Investment',
            'investment_withdrawal': 'Investment Withdrawal'
        };
        return map[(type || '').toLowerCase()] || (type || 'Transaction');
    }

    async function downloadReceipt() {
        const transactionId = document.getElementById('downloadReceiptBtn').dataset.transactionId;
        if (!transactionId) {
            showAlert('Transaction ID not found', 'error');
            return;
        }

        try {
            const token = localStorage.getItem('token');
            const response = await fetch(`${API_URL}/api/transactions/${transactionId}/receipt`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            // Check if response is PDF or JSON
            const contentType = response.headers.get('content-type');
            
            if (contentType && contentType.includes('application/pdf')) {
                // PDF response - download directly
                const blob = await response.blob();
                const url = window.URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = `receipt-${transactionId}.pdf`;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                window.URL.revokeObjectURL(url);
                showAlert('Receipt downloaded successfully!', 'success');
            } else {
                // JSON response - handle as error or fallback
                const data = await response.json();
                if (data.success) {
                    showAlert('Receipt generated. Check your downloads folder.', 'success');
                } else {
                    throw new Error(data.message || 'Failed to generate receipt');
                }
            }
        } catch (e) {
            console.error('Receipt download error:', e);
            showAlert(`Error: ${e.message}`, 'error');
        }
    }
</script>

<!-- Modal Styles -->
<style>
    .modal-overlay {
        display: none;
        position: fixed;
        z-index: 1000;
        left: 0;
        top: 0;
        width: 100%;
        height: 100%;
        background: rgba(0,0,0,0.5);
        overflow-y: auto;
    }

    .modal-content {
        background: white;
        margin: 50px auto;
        padding: 30px;
        border-radius: 12px;
        max-width: 600px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.2);
    }

    .transaction-modal {
        margin: 40px auto;
    }

    .modal-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 20px;
        padding-bottom: 15px;
        border-bottom: 2px solid #dee2e6;
    }

    .modal-header h2 {
        margin: 0;
        color: #1a472a;
        font-size: 22px;
    }

    .close-btn {
        background: none;
        border: none;
        font-size: 28px;
        cursor: pointer;
        color: #999;
    }

    .close-btn:hover {
        color: #1a472a;
    }

    .modal-body {
        margin: 20px 0;
    }

    .modal-footer {
        display: flex;
        gap: 12px;
        justify-content: flex-end;
        margin-top: 25px;
        padding-top: 15px;
        border-top: 1px solid #dee2e6;
    }

    .btn {
        padding: 10px 20px;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        font-weight: 600;
        transition: 0.3s;
    }

    .btn-primary {
        background: #667eea;
        color: white;
    }

    .btn-primary:hover {
        background: #764ba2;
    }

    .btn-secondary {
        background: #6c757d;
        color: white;
    }

    .btn-secondary:hover {
        background: #5a6268;
    }

    @media (max-width: 768px) {
        .modal-content {
            margin: 20px auto;
            padding: 20px;
        }

        .modal-footer {
            flex-direction: column;
        }

        .btn {
            width: 100%;
        }
    }
</style>
