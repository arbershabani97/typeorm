import { QueryRunnerAlreadyReleasedError } from "../../error/QueryRunnerAlreadyReleasedError"
import { QueryFailedError } from "../../error/QueryFailedError"
import { AbstractSqliteQueryRunner } from "../sqlite-abstract/AbstractSqliteQueryRunner"
import { TransactionNotStartedError } from "../../error/TransactionNotStartedError"
import { ExpoDriver } from "./ExpoDriver"
import { Broadcaster } from "../../subscriber/Broadcaster"
import { QueryResult } from "../../query-runner/QueryResult"
import { BroadcasterResult } from "../../subscriber/BroadcasterResult"

interface ITransaction {
    runAsync: (source: string, ...params: any[]) => Promise<any>
    getAllAsync: (source: string, ...params: any[]) => Promise<any>
}

/**
 * Runs queries on a single sqlite database connection.
 */
export class ExpoQueryRunner extends AbstractSqliteQueryRunner {
    /**
     * Database driver used by connection.
     */
    driver: ExpoDriver

    /**
     * Database transaction object
     */
    private transaction?: ITransaction

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(driver: ExpoDriver) {
        super()
        this.driver = driver
        this.connection = driver.connection
        this.broadcaster = new Broadcaster(this)
    }

    /**
     * Starts transaction. Within Expo, all database operations happen in a
     * transaction context, so issuing a `BEGIN TRANSACTION` command is
     * redundant and will result in the following error:
     *
     * `Error: Error code 1: cannot start a transaction within a transaction`
     *
     * Instead, we keep track of a `Transaction` object in `this.transaction`
     * and continue using the same object until we wish to commit the
     * transaction.
     */
    async startTransaction(): Promise<void> {
        this.isTransactionActive = true
        try {
            await this.broadcaster.broadcast("BeforeTransactionStart")
        } catch (err) {
            this.isTransactionActive = false
            throw err
        }

        this.transactionDepth += 1

        await this.broadcaster.broadcast("AfterTransactionStart")
    }

    /**
     * Commits transaction.
     * Error will be thrown if transaction was not started.
     * Since Expo will automatically commit the transaction once all the
     * callbacks of the transaction object have been completed, "committing" a
     * transaction in this driver's context means that we delete the transaction
     * object and set the stage for the next transaction.
     */
    async commitTransaction(): Promise<void> {
        if (
            !this.isTransactionActive &&
            typeof this.transaction === "undefined"
        )
            throw new TransactionNotStartedError()

        await this.broadcaster.broadcast("BeforeTransactionCommit")

        this.transaction = undefined
        this.isTransactionActive = false

        this.transactionDepth -= 1

        await this.broadcaster.broadcast("AfterTransactionCommit")
    }

    /**
     * Rollbacks transaction.
     * Error will be thrown if transaction was not started.
     * This method's functionality is identical to `commitTransaction()` because
     * the transaction lifecycle is handled within the Expo transaction object.
     * Issuing separate statements for `COMMIT` or `ROLLBACK` aren't necessary.
     */
    async rollbackTransaction(): Promise<void> {
        if (
            !this.isTransactionActive &&
            typeof this.transaction === "undefined"
        )
            throw new TransactionNotStartedError()

        await this.broadcaster.broadcast("BeforeTransactionRollback")

        this.transaction = undefined
        this.isTransactionActive = false

        this.transactionDepth -= 1

        await this.broadcaster.broadcast("AfterTransactionRollback")
    }

    /**
     * Called before migrations are run.
     */
    async beforeMigration(): Promise<void> {
        const databaseConnection = await this.connect()
        return new Promise((ok, fail) => {
            try {
                databaseConnection.execSync("PRAGMA foreign_keys = OFF");
                ok();
            } catch (error) {
                fail(error);
            }
        })
    }

    /**
     * Called after migrations are run.
     */
    async afterMigration(): Promise<void> {
        const databaseConnection = await this.connect()
        return new Promise((ok, fail) => {
            try {
                databaseConnection.execSync("PRAGMA foreign_keys = ON");
                ok();
            } catch (error) {
                fail(error);
            }
        })
    }

    /**
     * Executes a given SQL query.
     */
    async query(
        query: string,
        parameters?: any[],
        useStructuredResult = false,
    ): Promise<any> {
        if (this.isReleased) throw new QueryRunnerAlreadyReleasedError()

        return new Promise<any>(async (ok, fail) => {
            const databaseConnection = await this.connect()
            const broadcasterResult = new BroadcasterResult()

            this.driver.connection.logger.logQuery(query, parameters, this)
            this.broadcaster.broadcastBeforeQueryEvent(
                broadcasterResult,
                query,
                parameters,
            )

            const queryStartTime = +new Date()
            // All Expo SQL queries are executed in a transaction context
            databaseConnection.withExclusiveTransactionAsync(
                async (transaction: ITransaction) => {
                    if (typeof this.transaction === "undefined") {
                        await this.startTransaction()
                        this.transaction = transaction
                    }
                    try {
                        let t
                        let rows
                        try {
                            t = await transaction.runAsync(
                                query,
                                parameters || [],
                            )
                            rows = await t.getAllAsync(query, parameters || [])
                        } catch (error) {
                            rows = await transaction.getAllAsync(
                                query,
                                parameters || [],
                            )
                        }

                        // log slow queries if maxQueryExecution time is set
                        const maxQueryExecutionTime =
                            this.driver.options.maxQueryExecutionTime
                        const queryEndTime = +new Date()
                        const queryExecutionTime = queryEndTime - queryStartTime

                        this.broadcaster.broadcastAfterQueryEvent(
                            broadcasterResult,
                            query,
                            parameters,
                            true,
                            queryExecutionTime,
                            rows,
                            undefined,
                        )
                        await broadcasterResult.wait()

                        if (
                            maxQueryExecutionTime &&
                            queryExecutionTime > maxQueryExecutionTime
                        ) {
                            this.driver.connection.logger.logQuerySlow(
                                queryExecutionTime,
                                query,
                                parameters,
                                this,
                            )
                        }

                        const result = new QueryResult()

                        if (t?.hasOwnProperty("changes")) {
                            result.affected = t.changes
                        }

                        if (rows?.length) {
                            let resultSet = []
                            for (let i = 0; i < rows.length; i++) {
                                resultSet.push(rows[i])
                            }

                            result.raw = resultSet
                            result.records = resultSet
                        }

                        // return id of inserted row, if query was insert statement.
                        if (query.startsWith("INSERT INTO")) {
                            result.raw = t?.lastInsertRowId
                        }

                        if (useStructuredResult) {
                            ok(result)
                        } else {
                            ok(result?.raw || [])
                        }
                    } catch (err) {
                        this.driver.connection.logger.logQueryError(
                            err,
                            query,
                            parameters,
                            this,
                        )
                        this.broadcaster.broadcastAfterQueryEvent(
                            broadcasterResult,
                            query,
                            parameters,
                            false,
                            undefined,
                            undefined,
                            err,
                        )
                        await broadcasterResult.wait()

                        fail(new QueryFailedError(query, parameters, err))
                    }
                },
                async (err: any) => {
                    await this.rollbackTransaction()
                    fail(err)
                },
                () => {
                    this.isTransactionActive = false
                    this.transaction = undefined
                },
            )
        })
    }
}
