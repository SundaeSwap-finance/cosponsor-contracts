use cardano/assets.{PolicyId}
use cardano/transaction.{Transaction}

validator always_true {
  mint(_r: Data, _policy_id: PolicyId, _transaction: Transaction) {
    True
  }

  else(_) {
    fail
  }
}
