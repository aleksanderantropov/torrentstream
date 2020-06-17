// This module contains everything to track downloading pieces/blocks
// Received and Requested are boolean arrays that track every piece/block we received/requested
// We need both to track lost pieces/blocks

module.exports = class {
    constructor( parser ) {
        this.parser = parser;
        // blocks we requested
        this.requested = [];
        // blocks we received
        this.received = [];
        // if we requested and never received something this will be set to true
        this.lost = false;
    }

    // check if we need this piece or block
    needed(pindex, bindex = null) {
        if (bindex !== null)
            return !this.requested[pindex][bindex];
        return !this.requested[pindex].every(block => block);
    }

    complete() {
        // check if we received every block
        if ( this.received.every( blocks => blocks.every( block => block) ) )
            return true;

        // check if we requested every block
        if ( this.requested.every( blocks => blocks.every( block => block) ) ) {
            this.lost = true;
            // reset requested to received
            this.requested = this.received.map( blocks => blocks.slice() );
        }
        return false;
    }
    // get all missing pieces
    missing() {
        const missing = [];
        this.received.forEach(
            (blocks, index) => {
                if ( !blocks.every(block => block) )
                    missing.push(index);
            }
        );
        return missing;
    }
};